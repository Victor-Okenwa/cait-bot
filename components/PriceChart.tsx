"use client";

import { useEffect, useRef, useState } from "react";
import {
  LineChart, Line,
  AreaChart, Area,
  ComposedChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TrendingUp, TrendingDown, Minus,
  CandlestickChart, LineChart as LineIcon, AreaChart as AreaIcon,
  Maximize2, Minimize2, RefreshCw,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type ChartType = "line" | "area" | "candle";
type DurationKey = "1m" | "5m" | "15m" | "30m" | "1h" | "1d" | "30d" | "3mo" | "1y";

type LivePoint   = { ts: number; price: number };
type LinePoint   = { time: string; price: number };
type CandlePoint = { time: string; open: number; high: number; low: number; close: number };
type ChartPoint  = LinePoint | CandlePoint;

type DurationConfig = {
  label: string;
  live: boolean;
  windowMs?: number;
  days?: number;
};

// ─── Config ───────────────────────────────────────────────────────────────────

const DURATIONS: Record<DurationKey, DurationConfig> = {
  "1m":  { label: "1m",  live: true,  windowMs: 60_000 },
  "5m":  { label: "5m",  live: true,  windowMs: 5  * 60_000 },
  "15m": { label: "15m", live: true,  windowMs: 15 * 60_000 },
  "30m": { label: "30m", live: true,  windowMs: 30 * 60_000 },
  "1h":  { label: "1h",  live: true,  windowMs: 60 * 60_000 },
  "1d":  { label: "1d",  live: false, days: 1   },
  "30d": { label: "30d", live: false, days: 30  },
  "3mo": { label: "3mo", live: false, days: 90  },
  "1y":  { label: "1y",  live: false, days: 365 },
};

const DURATION_KEYS = Object.keys(DURATIONS) as DurationKey[];
const MAX_LIVE_POINTS = 120;
const LIVE_POLL_MS    = 60_000;

const CHART_TYPES: { key: ChartType; label: string; Icon: React.ElementType }[] = [
  { key: "line",   label: "Line",   Icon: LineIcon        },
  { key: "area",   label: "Area",   Icon: AreaIcon        },
  { key: "candle", label: "Candle", Icon: CandlestickChart },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtLiveTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtHistTime(ts: number, days: number) {
  const d = new Date(ts);
  return days <= 1
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function precision(price: number) {
  if (price < 0.001) return 7;
  if (price < 0.01)  return 6;
  if (price < 1)     return 5;
  return 4;
}

/** Aggregate an array of live points into N candlestick buckets */
function aggregateCandles(points: LivePoint[], buckets = 24): CandlePoint[] {
  if (points.length === 0) return [];
  const size = Math.max(1, Math.ceil(points.length / buckets));
  const result: CandlePoint[] = [];
  for (let i = 0; i < points.length; i += size) {
    const group  = points.slice(i, i + size);
    const prices = group.map((p) => p.price);
    result.push({
      time:  fmtLiveTime(group[0].ts),
      open:  prices[0],
      high:  Math.max(...prices),
      low:   Math.min(...prices),
      close: prices[prices.length - 1],
    });
  }
  return result;
}

// ─── Custom candlestick shape ─────────────────────────────────────────────────

function CandlestickBar(props: any) {
  const { x, width, open, high, low, close, yAxis } = props;

  // Defensive: yAxis.scale may not exist for the very first render tick
  const scale = yAxis?.scale ?? yAxis?.yScale;
  if (typeof scale !== "function") return null;
  if (open == null || high == null || low == null || close == null) return null;

  const yOpen   = scale(open);
  const yClose  = scale(close);
  const yHigh   = scale(high);
  const yLow    = scale(low);
  const isUp    = close >= open;
  const color   = isUp ? "#22c55e" : "#ef4444";
  const bodyTop = Math.min(yOpen, yClose);
  const bodyH   = Math.max(Math.abs(yClose - yOpen), 1);
  const cx      = x + width / 2;
  const barW    = Math.max(width - 3, 2);

  return (
    <g>
      {/* Full wick high → low */}
      <line x1={cx} y1={yHigh} x2={cx} y2={yLow} stroke={color} strokeWidth={1.5} />
      {/* Body open ↔ close */}
      <rect
        x={cx - barW / 2}
        y={bodyTop}
        width={barW}
        height={bodyH}
        fill={color}
        fillOpacity={0.85}
        rx={1}
      />
    </g>
  );
}

// ─── Custom candle tooltip ────────────────────────────────────────────────────

function CandleTooltip({ active, payload, label, prec }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload as CandlePoint;
  if (!d?.open) return null;
  const up = d.close >= d.open;
  return (
    <div className="rounded-lg border border-white/10 bg-[#1a1a2e] px-3 py-2 text-xs text-white shadow-xl">
      <p className="text-white/50 mb-1">{label}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        <span className="text-white/50">O</span><span>${d.open.toFixed(prec)}</span>
        <span className="text-white/50">H</span><span className="text-emerald-400">${d.high.toFixed(prec)}</span>
        <span className="text-white/50">L</span><span className="text-red-400">${d.low.toFixed(prec)}</span>
        <span className="text-white/50">C</span>
        <span className={up ? "text-emerald-400" : "text-red-400"}>${d.close.toFixed(prec)}</span>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PriceChart() {
  const [chartType,        setChartType]        = useState<ChartType>("line");
  const [selectedDuration, setSelectedDuration] = useState<DurationKey>("1h");
  const [chartData,        setChartData]        = useState<ChartPoint[]>([]);
  const [currentPrice,     setCurrentPrice]     = useState<number | null>(null);
  const [loading,          setLoading]          = useState(true);
  const [error,            setError]            = useState<string | null>(null);
  const [isFullscreen,     setIsFullscreen]     = useState(false);

  const liveBuffer   = useRef<LivePoint[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Fullscreen ──────────────────────────────────────────────────────────────

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }

  useEffect(() => {
    function onFSChange() { setIsFullscreen(!!document.fullscreenElement); }
    document.addEventListener("fullscreenchange", onFSChange);
    return () => document.removeEventListener("fullscreenchange", onFSChange);
  }, []);

  // ── Live buffer rebuilds ────────────────────────────────────────────────────

  function rebuildFromBuffer(dur: DurationKey, type: ChartType) {
    const cfg = DURATIONS[dur];
    if (!cfg.live || !cfg.windowMs) return;
    const cutoff  = Date.now() - cfg.windowMs;
    const filtered = liveBuffer.current.filter((p) => p.ts >= cutoff);

    if (type === "candle") {
      setChartData(aggregateCandles(filtered));
    } else {
      setChartData(filtered.map((p) => ({ time: fmtLiveTime(p.ts), price: p.price })));
    }
  }

  // ── Historical: line/area ───────────────────────────────────────────────────

  async function fetchHistoricalLine(days: number) {
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
      const step    = Math.max(1, Math.floor(prices.length / 120));
      const sampled = prices.filter((_, i) => i % step === 0);
      setChartData(sampled.map(([ts, price]) => ({ time: fmtHistTime(ts, days), price })));
      if (prices.length) setCurrentPrice(prices[prices.length - 1][1]);
    } catch (e: any) {
      setError(e.message ?? "Fetch failed");
    } finally {
      setLoading(false);
    }
  }

  // ── Historical: candle ──────────────────────────────────────────────────────

  async function fetchHistoricalOHLC(days: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/nervos-network/ohlc?vs_currency=usd&days=${days}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`CoinGecko OHLC ${res.status}`);
      const raw: [number, number, number, number, number][] = await res.json();
      const step    = Math.max(1, Math.floor(raw.length / 120));
      const sampled = raw.filter((_, i) => i % step === 0);
      const points: CandlePoint[] = sampled.map(([ts, o, h, l, c]) => ({
        time:  fmtHistTime(ts, days),
        open:  o, high: h, low: l, close: c,
      }));
      setChartData(points);
      if (raw.length) setCurrentPrice(raw[raw.length - 1][4]);
    } catch (e: any) {
      setError(e.message ?? "Fetch failed");
    } finally {
      setLoading(false);
    }
  }

  // ── Live price polling ──────────────────────────────────────────────────────

  async function fetchLivePrice() {
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=nervos-network&vs_currencies=usd",
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
      const json  = await res.json();
      const price = json["nervos-network"]?.usd as number;
      if (!price) throw new Error("No price in response");

      liveBuffer.current.push({ ts: Date.now(), price });
      if (liveBuffer.current.length > MAX_LIVE_POINTS) liveBuffer.current.shift();

      setCurrentPrice(price);
      setError(null);

      // Rebuild live chart in-place without triggering the duration/type effect
      setSelectedDuration((dur) => {
        if (DURATIONS[dur].live) {
          setChartType((type) => { rebuildFromBuffer(dur, type); return type; });
        }
        return dur;
      });
    } catch (e: any) {
      setError(e.message ?? "Fetch failed");
    } finally {
      setLoading(false);
    }
  }

  // ── On duration or chart type change ─────────────────────────────────────────

  useEffect(() => {
    const cfg = DURATIONS[selectedDuration];
    if (cfg.live) {
      rebuildFromBuffer(selectedDuration, chartType);
    } else {
      if (chartType === "candle") {
        fetchHistoricalOHLC(cfg.days!);
      } else {
        fetchHistoricalLine(cfg.days!);
      }
    }
  }, [selectedDuration, chartType]);

  // ── Start live poll ───────────────────────────────────────────────────────

  useEffect(() => {
    fetchLivePrice();
    const id = setInterval(fetchLivePrice, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────

  const isCandle = chartType === "candle";
  const prec     = currentPrice ? precision(currentPrice) : 6;

  const prices = isCandle
    ? (chartData as CandlePoint[]).flatMap((d) => [d.high, d.low])
    : (chartData as LinePoint[]).map((d) => d.price);

  const minP = prices.length ? Math.min(...prices) * 0.999 : 0;
  const maxP = prices.length ? Math.max(...prices) * 1.001 : 1;

  const lastTwo = chartData.slice(-2);
  const trendDelta = lastTwo.length === 2
    ? (isCandle
        ? (lastTwo[1] as CandlePoint).close - (lastTwo[0] as CandlePoint).close
        : (lastTwo[1] as LinePoint).price   - (lastTwo[0] as LinePoint).price)
    : 0;

  const trend      = trendDelta > 0 ? "up" : trendDelta < 0 ? "down" : "flat";
  const TrendIcon  = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendColor = trend === "up" ? "text-emerald-400" : trend === "down" ? "text-red-400" : "text-white/40";

  const cfg         = DURATIONS[selectedDuration];
  const chartHeight = isFullscreen ? "calc(100vh - 160px)" : 240;

  const axisProps = {
    tick:      { fill: "rgba(255,255,255,0.3)", fontSize: 10 },
    tickLine:  false as const,
    axisLine:  false as const,
  };

  const tooltipStyle = {
    contentStyle: {
      background: "#1a1a2e",
      border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: 8,
      color: "#fff",
      fontSize: 12,
    },
    labelStyle: { color: "rgba(255,255,255,0.5)" },
  };

  // ─── Render chart body ───────────────────────────────────────────────────────

  function renderChart() {
    if (loading) return <Skeleton className="w-full bg-white/10 rounded-lg" style={{ height: chartHeight }} />;

    const shared = {
      data: chartData,
      margin: { top: 4, right: 8, left: 0, bottom: 0 },
    };

    const xAxis = (
      <XAxis dataKey="time" {...axisProps} interval="preserveStartEnd" />
    );
    const yAxis = (
      <YAxis
        domain={[minP, maxP]}
        {...axisProps}
        tickFormatter={(v) => `$${v.toFixed(prec)}`}
        width={78}
      />
    );
    const grid = <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />;

    if (chartType === "line") {
      return (
        <ResponsiveContainer width="100%" height={chartHeight}>
          <LineChart {...shared}>
            {grid}{xAxis}{yAxis}
            <Tooltip
              {...tooltipStyle}
              formatter={(v: number) => [`$${v.toFixed(prec)}`, "CKB"]}
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
      );
    }

    if (chartType === "area") {
      return (
        <ResponsiveContainer width="100%" height={chartHeight}>
          <AreaChart {...shared}>
            <defs>
              <linearGradient id="ckbGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#22d3ee" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#22d3ee" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            {grid}{xAxis}{yAxis}
            <Tooltip
              {...tooltipStyle}
              formatter={(v: number) => [`$${v.toFixed(prec)}`, "CKB"]}
            />
            <Area
              type="monotone"
              dataKey="price"
              stroke="#22d3ee"
              strokeWidth={2}
              fill="url(#ckbGrad)"
              dot={false}
              activeDot={{ r: 4, fill: "#22d3ee" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      );
    }

    // Candle
    return (
      <ResponsiveContainer width="100%" height={chartHeight}>
        <ComposedChart {...shared}>
          {grid}{xAxis}
          <YAxis
            domain={[minP, maxP]}
            {...axisProps}
            tickFormatter={(v) => `$${v.toFixed(prec)}`}
            width={78}
          />
          <Tooltip content={<CandleTooltip prec={prec} />} />
          {/*
            dataKey="high" ensures the bar slot spans the full candle range.
            shape as render function guarantees all props (incl. yAxis.scale) are forwarded.
            fill/stroke transparent so recharts default bar rect is invisible.
          */}
          <Bar
            dataKey="high"
            shape={(props: any) => <CandlestickBar {...props} />}
            isAnimationActive={false}
            fill="transparent"
            stroke="transparent"
            background={{ fill: "transparent" }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  // ─── Main render ─────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className={isFullscreen ? "bg-[#0d0d1a] p-6 flex flex-col" : ""}
    >
      <Card className="bg-white/5 border-white/10 text-white flex flex-col flex-1">
        <CardHeader className="pb-2">
          {/* Row 1: title + price + fullscreen */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base font-semibold text-white/80">
              CKB / USD
            </CardTitle>

            <div className="flex items-center gap-2 flex-wrap">
              {loading ? (
                <Skeleton className="h-6 w-24 bg-white/10" />
              ) : error ? (
                <Badge variant="destructive" className="text-xs">{error}</Badge>
              ) : (
                <div className="flex items-center gap-1.5">
                  <TrendIcon className={`w-4 h-4 ${trendColor}`} />
                  <span className="text-lg font-bold text-cyan-300">
                    ${currentPrice?.toFixed(prec)}
                  </span>
                </div>
              )}

              <Badge variant="outline" className="text-[10px] border-white/20 text-white/40">
                CoinGecko
              </Badge>

              {/* Fullscreen button */}
              <button
                onClick={toggleFullscreen}
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                className="flex items-center justify-center w-7 h-7 rounded-md border border-white/10 bg-white/5 hover:bg-white/10 text-white/50 hover:text-white transition-colors"
              >
                {isFullscreen
                  ? <Minimize2 className="w-3.5 h-3.5" />
                  : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Row 2: chart type + duration selectors */}
          <div className="flex items-center gap-2 flex-wrap mt-2">
            {/* Chart type */}
            <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/5 p-0.5">
              {CHART_TYPES.map(({ key, label, Icon }) => (
                <button
                  key={key}
                  onClick={() => setChartType(key)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    chartType === key
                      ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                      : "text-white/40 hover:text-white/70"
                  }`}
                >
                  <Icon className="w-3 h-3" />
                  {label}
                </button>
              ))}
            </div>

            {/* Duration */}
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
          </div>
        </CardHeader>

        <CardContent className="pt-0 flex-1">
          {renderChart()}
          <p className="text-[10px] text-white/20 mt-1.5 text-right">
            {cfg.live
              ? `Live · updates every 60s · ${chartData.length} points`
              : `Historical · ${chartData.length} ${isCandle ? "candles" : "points"} · refreshes on switch`}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
