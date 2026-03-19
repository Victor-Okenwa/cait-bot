"use client";

import { useEffect, useRef, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type LivePoint = { ts: number; price: number };   // raw buffer entry
type ChartPoint = { time: string; price: number }; // recharts display entry

type DurationKey = "1m" | "5m" | "15m" | "30m" | "1h" | "1d" | "30d" | "3mo" | "1y";

type DurationConfig = {
  label: string;
  live: boolean;
  windowMs?: number;   // live only: filter buffer to last N ms
  days?: number;       // historical only: CoinGecko days param
};

// ─── Duration config ──────────────────────────────────────────────────────────

const DURATIONS: Record<DurationKey, DurationConfig> = {
  "1m":  { label: "1m",   live: true,  windowMs: 60_000 },
  "5m":  { label: "5m",   live: true,  windowMs: 5  * 60_000 },
  "15m": { label: "15m",  live: true,  windowMs: 15 * 60_000 },
  "30m": { label: "30m",  live: true,  windowMs: 30 * 60_000 },
  "1h":  { label: "1h",   live: true,  windowMs: 60 * 60_000 },
  "1d":  { label: "1d",   live: false, days: 1 },
  "30d": { label: "30d",  live: false, days: 30 },
  "3mo": { label: "3mo",  live: false, days: 90 },
  "1y":  { label: "1y",   live: false, days: 365 },
};

const DURATION_KEYS = Object.keys(DURATIONS) as DurationKey[];

// Keep 1 hour of live ticks (60 ticks × 60s = 60 min)
const MAX_LIVE_POINTS = 120;
const LIVE_POLL_MS = 60_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatLiveTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatHistoricalTime(ts: number, days: number): string {
  const d = new Date(ts);
  if (days <= 1) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function pricePrecision(price: number): number {
  if (price < 0.001) return 7;
  if (price < 0.01)  return 6;
  if (price < 1)     return 5;
  return 4;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PriceChart() {
  const [selectedDuration, setSelectedDuration] = useState<DurationKey>("1h");
  const [chartData, setChartData]   = useState<ChartPoint[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);

  // Live buffer — persists across duration switches
  const liveBuffer = useRef<LivePoint[]>([]);

  // ── Live price fetch (runs always) ──────────────────────────────────────────
  async function fetchLivePrice() {
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=nervos-network&vs_currencies=usd",
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
      const json = await res.json();
      const price: number = json["nervos-network"]?.usd;
      if (!price) throw new Error("No price in response");

      const point: LivePoint = { ts: Date.now(), price };
      liveBuffer.current.push(point);
      if (liveBuffer.current.length > MAX_LIVE_POINTS) {
        liveBuffer.current.shift();
      }

      setCurrentPrice(price);
      setError(null);

      // If a live duration is selected, update chart immediately
      setSelectedDuration((dur) => {
        const cfg = DURATIONS[dur];
        if (cfg.live) rebuildLiveChart(dur);
        return dur;
      });
    } catch (err: any) {
      setError(err.message ?? "Fetch failed");
    } finally {
      setLoading(false);
    }
  }

  function rebuildLiveChart(dur: DurationKey) {
    const cfg = DURATIONS[dur];
    if (!cfg.live || !cfg.windowMs) return;
    const cutoff = Date.now() - cfg.windowMs;
    const filtered = liveBuffer.current.filter((p) => p.ts >= cutoff);
    setChartData(
      filtered.map((p) => ({ time: formatLiveTime(p.ts), price: p.price }))
    );
  }

  // ── Historical fetch (only for non-live durations) ──────────────────────────
  async function fetchHistorical(days: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/nervos-network/market_chart?vs_currency=usd&days=${days}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
      const json = await res.json();
      const prices: [number, number][] = json.prices ?? [];

      // Downsample to max 120 points for clean rendering
      const step = Math.max(1, Math.floor(prices.length / 120));
      const sampled = prices.filter((_, i) => i % step === 0);

      setChartData(
        sampled.map(([ts, price]) => ({
          time: formatHistoricalTime(ts, days),
          price,
        }))
      );

      // Update current price from last point
      if (prices.length > 0) {
        setCurrentPrice(prices[prices.length - 1][1]);
      }
    } catch (err: any) {
      setError(err.message ?? "Fetch failed");
    } finally {
      setLoading(false);
    }
  }

  // ── On duration change ───────────────────────────────────────────────────────
  useEffect(() => {
    const cfg = DURATIONS[selectedDuration];
    if (cfg.live) {
      rebuildLiveChart(selectedDuration);
    } else {
      fetchHistorical(cfg.days!);
    }
  }, [selectedDuration]);

  // ── Live polling (always on) ─────────────────────────────────────────────────
  useEffect(() => {
    fetchLivePrice();
    const id = setInterval(fetchLivePrice, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, []);

  // ── Trend ────────────────────────────────────────────────────────────────────
  const trend = (() => {
    if (chartData.length < 2) return "flat";
    const delta = chartData[chartData.length - 1].price - chartData[chartData.length - 2].price;
    if (delta > 0) return "up";
    if (delta < 0) return "down";
    return "flat";
  })();

  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendColor = trend === "up" ? "text-emerald-400" : trend === "down" ? "text-red-400" : "text-white/40";

  const precision = currentPrice ? pricePrecision(currentPrice) : 6;
  const minPrice = chartData.length ? Math.min(...chartData.map((d) => d.price)) * 0.999 : 0;
  const maxPrice = chartData.length ? Math.max(...chartData.map((d) => d.price)) * 1.001 : 1;

  const cfg = DURATIONS[selectedDuration];

  return (
    <Card className="bg-white/5 border-white/10 text-white">
      <CardHeader className="flex flex-row items-center justify-between pb-2 flex-wrap gap-2">
        <CardTitle className="text-base font-semibold text-white/80">
          CKB / USD
        </CardTitle>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Duration selector */}
          <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/5 p-0.5">
            {DURATION_KEYS.map((key) => (
              <button
                key={key}
                onClick={() => setSelectedDuration(key)}
                className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  selectedDuration === key
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                    : "text-white/40 hover:text-white/70"
                }`}
              >
                {DURATIONS[key].label}
              </button>
            ))}
          </div>

          {/* Price + trend */}
          {loading ? (
            <Skeleton className="h-6 w-24 bg-white/10" />
          ) : error ? (
            <Badge variant="destructive" className="text-xs">{error}</Badge>
          ) : (
            <div className="flex items-center gap-1.5">
              <TrendIcon className={`w-4 h-4 ${trendColor}`} />
              <span className="text-lg font-bold text-cyan-300">
                ${currentPrice?.toFixed(precision)}
              </span>
            </div>
          )}

          <Badge variant="outline" className="text-[10px] border-white/20 text-white/40">
            CoinGecko
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {loading ? (
          <Skeleton className="h-52 w-full bg-white/10 rounded-lg" />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="time"
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={[minPrice, maxPrice]}
                tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `$${v.toFixed(precision)}`}
                width={76}
              />
              <Tooltip
                contentStyle={{
                  background: "#1a1a2e",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8,
                  color: "#fff",
                  fontSize: 12,
                }}
                formatter={(value: number) => [`$${value.toFixed(precision)}`, "CKB"]}
                labelStyle={{ color: "rgba(255,255,255,0.5)" }}
              />
              <Line
                type="monotone"
                dataKey="price"
                stroke="#22d3ee"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: "#22d3ee" }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
        <p className="text-[10px] text-white/20 mt-1.5 text-right">
          {cfg.live
            ? `Live · updates every 60s · ${chartData.length} points`
            : `Historical · ${chartData.length} points · refreshes on switch`}
        </p>
      </CardContent>
    </Card>
  );
}
