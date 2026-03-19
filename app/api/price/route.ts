import { NextRequest, NextResponse } from "next/server";

const CG_BASE = "https://api.coingecko.com/api/v3";
const COIN_ID = "nervos-network";

// In-memory server-side cache — survives across requests within the same
// Next.js server process, avoiding redundant CoinGecko hits on every refresh.
type CacheEntry = { data: unknown; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function fromCache(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.data;
}

function toCache(key: string, data: unknown, ttlMs: number) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

async function cgFetch(url: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    // Let Next.js handle caching via our in-memory layer above
    cache: "no-store",
  });
  if (!res.ok) return { ok: false, status: res.status, data: null };
  const data = await res.json();
  return { ok: true, status: 200, data };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "simple"; // simple | chart | ohlc
  const days = searchParams.get("days") ?? "1";

  // ── Simple price ── cache 30s ────────────────────────────────────────────────
  if (type === "simple") {
    const cacheKey = "simple";
    const cached = fromCache(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { "X-Cache": "HIT", "Cache-Control": "public, max-age=30" },
      });
    }

    const { ok, status, data } = await cgFetch(
      `${CG_BASE}/simple/price?ids=${COIN_ID}&vs_currencies=usd`
    );
    if (!ok) return NextResponse.json({ error: `CoinGecko ${status}` }, { status });

    toCache(cacheKey, data, 30_000); // 30s TTL
    return NextResponse.json(data, {
      headers: { "X-Cache": "MISS", "Cache-Control": "public, max-age=30" },
    });
  }

  // ── Market chart (line/area) ── cache 3 min for short, 10 min for long ───────
  if (type === "chart") {
    const cacheKey = `chart-${days}`;
    const cached = fromCache(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { "X-Cache": "HIT" },
      });
    }

    const { ok, status, data } = await cgFetch(
      `${CG_BASE}/coins/${COIN_ID}/market_chart?vs_currency=usd&days=${days}`
    );
    if (!ok) return NextResponse.json({ error: `CoinGecko ${status}` }, { status });

    const ttl = parseInt(days) <= 1 ? 3 * 60_000 : 10 * 60_000;
    toCache(cacheKey, data, ttl);
    return NextResponse.json(data, { headers: { "X-Cache": "MISS" } });
  }

  // ── OHLC (candle) ── cache 3 min for short, 10 min for long ─────────────────
  if (type === "ohlc") {
    const cacheKey = `ohlc-${days}`;
    const cached = fromCache(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { "X-Cache": "HIT" },
      });
    }

    const { ok, status, data } = await cgFetch(
      `${CG_BASE}/coins/${COIN_ID}/ohlc?vs_currency=usd&days=${days}`
    );
    if (!ok) return NextResponse.json({ error: `CoinGecko ${status}` }, { status });

    const ttl = parseInt(days) <= 1 ? 3 * 60_000 : 10 * 60_000;
    toCache(cacheKey, data, ttl);
    return NextResponse.json(data, { headers: { "X-Cache": "MISS" } });
  }

  return NextResponse.json({ error: "Invalid type param" }, { status: 400 });
}
