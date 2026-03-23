"use client";

import { useEffect, useRef, useState } from "react";
import {
  ComposedChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
  BarShapeProps,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TrendingUp, TrendingDown, Minus,
  CandlestickChart, LineChart as LineIcon, AreaChart as AreaIcon,
  Maximize2, Minimize2, RefreshCw,
} from "lucide-react";
import { ActiveShape } from "recharts/types/util/types";

// ─── Types ────────────────────────────────────────────────────────────────────

type ChartType   = "line" | "area" | "candle";
type DurationKey = "1m" | "5m" | "15m" | "30m" | "1h" | "1d" | "30d";

type LinePoint   = { time: string; price: number };
type CandlePoint = { time: string; open: number; high: number; low: number; close: number };
type ChartPoint  = LinePoint | CandlePoint;

type DurationConfig = {
  label: string;
  /** days param for market_chart (line / area) */
  chartDays: number | "max";
  /** days param for ohlc (candle) — must be a CoinGecko-supported value:
   *  1 → 30-min bars | 7/14/30 → 4-hour bars | 90/180/365 → daily bars */
  ohlcDays: number;
  description: string;
  refreshMs: number;
};

// ─── Duration config ──────────────────────────────────────────────────────────

const DURATIONS: Record<DurationKey, DurationConfig> = {
  "1m":  { label:"1m",  chartDays:1,     ohlcDays:1,   description:"24h",       refreshMs:60_000     },
  "5m":  { label:"5m",  chartDays:1,     ohlcDays:1,   description:"24h",       refreshMs:60_000     },
  "15m": { label:"15m", chartDays:3,     ohlcDays:1,   description:"72h",       refreshMs:5*60_000   },
  "30m": { label:"30m", chartDays:10,    ohlcDays:7,   description:"10d",       refreshMs:10*60_000  },
  "1h":  { label:"1h",  chartDays:10,    ohlcDays:14,  description:"10d",       refreshMs:10*60_000  },
  "1d":  { label:"1d",  chartDays:30,    ohlcDays:90,  description:"30d",       refreshMs:30*60_000  },
  "30d": { label:"30d", chartDays:"max", ohlcDays:365, description:"All time",  refreshMs:60*60_000  },
};

const DURATION_KEYS = Object.keys(DURATIONS) as DurationKey[];

const CHART_TYPES: { key: ChartType; label: string; Icon: React.ElementType }[] = [
  { key: "line",   label: "Line",   Icon: LineIcon         },
  { key: "area",   label: "Area",   Icon: AreaIcon         },
  { key: "candle", label: "Candle", Icon: CandlestickChart },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(ts: number, days: number | "max"): string {
  const d = new Date(ts);
  const n = days === "max" ? 9999 : (days as number);
  if (n <= 3)  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (n <= 90) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { year: "numeric", month: "short" });
}

function precision(price: number) {
  if (price < 0.001) return 7;
  if (price < 0.01)  return 6;
  if (price < 1)     return 5;
  return 4;
}

function safeMin(arr: number[]) { return arr.reduce((a, b) => Math.min(a, b), Infinity); }
function safeMax(arr: number[]) { return arr.reduce((a, b) => Math.max(a, b), -Infinity); }

// ─── Candlestick shape ────────────────────────────────────────────────────────
//
// Recharts always passes `background` to Bar shape functions — it is the full
// chart-area rectangle: { x, y, width, height }.  We use it together with the
// price domain (closed-over minP / maxP) to convert price → pixel Y without
// relying on the unreliable yAxis.scale reference.

function makeCandlestickShape(minPrice: number, maxPrice: number) {
  return function CandlestickShape(props: { x: number; width: number; background: { y: number; height: number }; open: number; high: number; low: number; close: number }) {
    const { x, width, background, open, high, low, close } = props;
    if (!background?.height) return null;
    if (open == null || high == null || low == null || close == null) return null;

    const priceRange = maxPrice - minPrice;
    if (priceRange === 0) return null;

    const toPixel = (p: number) =>
      background.y + ((maxPrice - p) / priceRange) * background.height;

    const yHigh  = toPixel(high);
    const yLow   = toPixel(low);
    const yOpen  = toPixel(open);
    const yClose = toPixel(close);
    const isUp   = close >= open;
    const color  = isUp ? "#22c55e" : "#ef4444";
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH   = Math.max(Math.abs(yClose - yOpen), 2);
    const midX    = x + width / 2;
    const bodyW   = Math.max(width * 0.7, 2);

    return (
      <g>
        {/* Upper wick */}
        <line x1={midX} y1={yHigh} x2={midX} y2={bodyTop} stroke={color} strokeWidth={1} />
        {/* Lower wick */}
        <line x1={midX} y1={bodyTop + bodyH} x2={midX} y2={yLow} stroke={color} strokeWidth={1} />
        {/* Body */}
        <rect
          x={midX - bodyW / 2} y={bodyTop}
          width={bodyW} height={bodyH}
          fill={color} fillOpacity={isUp ? 0.25 : 0.85}
          stroke={color} strokeWidth={1} rx={1}
        />
      </g>
    );
  };
}

// ─── Candle tooltip ───────────────────────────────────────────────────────────

function CandleTooltip({ active, payload, label, prec }: { active: boolean; payload: { payload: CandlePoint }[]; label: string; prec: number }) {
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

// ─── Fetch with retry ─────────────────────────────────────────────────────────

async function fetchWithRetry(url: string, maxAttempts = 3, baseDelayMs = 1500): Promise<Response> {
  let lastError: Error = new Error("Unknown fetch error");
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(res.status === 429 ? "Rate limited — retrying…" : `Server error ${res.status}`);
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
          continue;
        }
      }
      return res;
    } catch (e: unknown) {
      lastError = e as Error;
      if (attempt < maxAttempts - 1)
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PriceChart() {
  const [chartType,        setChartType]        = useState<ChartType>("line");
  const [selectedDuration, setSelectedDuration] = useState<DurationKey>("1h");
  const [chartData,        setChartData]        = useState<ChartPoint[]>([]);
  const [currentPrice,     setCurrentPrice]     = useState<number | null>(null);
  const [loading,          setLoading]          = useState(true);
  const [refetching,       setRefetching]       = useState(false);
  const [error,            setError]            = useState<string | null>(null);
  const [isFullscreen,     setIsFullscreen]     = useState(false);
  const [fsHeight,         setFsHeight]         = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  // Plain div — overflow-x:auto gives us full control incl. scrollLeft.
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Fullscreen ──────────────────────────────────────────────────────────────

  function toggleFullscreen() {
    if (!document.fullscreenElement) containerRef.current?.requestFullscreen();
    else document.exitFullscreen();
  }

  useEffect(() => {
    function onFSChange() {
      const inFS = !!document.fullscreenElement;
      setIsFullscreen(inFS);
      if (inFS) setFsHeight(window.innerHeight);
    }
    document.addEventListener("fullscreenchange", onFSChange);
    return () => document.removeEventListener("fullscreenchange", onFSChange);
  }, []);

  // ── Scroll to the most-recent (rightmost) bar after data loads ──────────────

  useEffect(() => {
    if (!chartData.length || !scrollRef.current) return;
    const el = scrollRef.current;
    // Small delay so Recharts finishes painting before we scroll.
    setTimeout(() => { el.scrollLeft = el.scrollWidth; }, 80);
  }, [chartData]);

  // ── Fetch data ──────────────────────────────────────────────────────────────
  //
  // Line / area  → market_chart endpoint  → prices: [ts, price][]
  // Candle       → ohlc endpoint          → [ts, open, high, low, close][]
  //
  // Using the OHLC endpoint for candles is essential: market_chart gives a
  // single price per timestamp, so aggregating it into OHLC produces candles
  // where open=high=low=close (a dot). The OHLC endpoint gives real spreads.

  async function fetchData(dur: DurationKey, type: ChartType, silent = false) {
    const cfg = DURATIONS[dur];
    if (!silent) setLoading(true);
    else         setRefetching(true);
    setError(null);

    try {
      if (type === "candle") {
        // ── OHLC ─────────────────────────────────────────────────────────────
        const res = await fetchWithRetry(`/api/price?type=ohlc&days=${cfg.ohlcDays}`);
        if (!res.ok) throw new Error(`Price API ${res.status}`);
        const raw: [number, number, number, number, number][] = await res.json();
        if (!Array.isArray(raw) || raw.length === 0) throw new Error("No OHLC data");

        setCurrentPrice(raw[raw.length - 1][4]);
        setChartData(raw.map(([ts, o, h, l, c]) => ({
          time: fmtTime(ts, cfg.ohlcDays),
          open: o, high: h, low: l, close: c,
        })));
      } else {
        // ── Market chart (line / area) ────────────────────────────────────────
        const res = await fetchWithRetry(`/api/price?type=chart&days=${cfg.chartDays}`);
        if (!res.ok) throw new Error(`Price API ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(json.error);
        const prices: [number, number][] = json.prices ?? [];
        if (!prices.length) throw new Error("No price data");

        setCurrentPrice(prices[prices.length - 1][1]);
        setChartData(prices.map(([ts, price]) => ({ time: fmtTime(ts, cfg.chartDays), price })));
      }
    } catch (e: unknown) {
      setError((e as Error).message ?? "Fetch failed");
    } finally {
      setLoading(false);
      setRefetching(false);
    }
  }

  // ── Refetch on duration / chart-type change ─────────────────────────────────

  useEffect(() => { fetchData(selectedDuration, chartType); }, [selectedDuration, chartType]);

  // ── Background auto-refresh ─────────────────────────────────────────────────

  useEffect(() => {
    const cfg = DURATIONS[selectedDuration];
    const id = setInterval(() => fetchData(selectedDuration, chartType, true), cfg.refreshMs);
    return () => clearInterval(id);
  }, [selectedDuration, chartType]);

  // ── Manual refetch ──────────────────────────────────────────────────────────

  function handleManualRefetch() { fetchData(selectedDuration, chartType, true); }

  // ── Derived values ──────────────────────────────────────────────────────────

  const isCandle = chartType === "candle";
  const prec     = currentPrice ? precision(currentPrice) : 6;

  const allPrices = isCandle
    ? (chartData as CandlePoint[]).flatMap((d) => [d.high, d.low])
    : (chartData as LinePoint[]).map((d) => d.price);

  const minP = allPrices.length ? safeMin(allPrices) * 0.999 : 0;
  const maxP = allPrices.length ? safeMax(allPrices) * 1.001 : 1;

  const lastTwo    = chartData.slice(-2);
  const trendDelta = lastTwo.length === 2
    ? isCandle
      ? (lastTwo[1] as CandlePoint).close - (lastTwo[0] as CandlePoint).close
      : (lastTwo[1] as LinePoint).price   - (lastTwo[0] as LinePoint).price
    : 0;
  const trend      = trendDelta > 0 ? "up" : trendDelta < 0 ? "down" : "flat";
  const TrendIcon  = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendColor = trend === "up" ? "text-emerald-400" : trend === "down" ? "text-red-400" : "text-white/40";

  const cfg = DURATIONS[selectedDuration];

  const chartPxHeight = isFullscreen ? Math.max(fsHeight - 150, 300) : 240;

  // Give each bar/point a minimum pixel width so the chart is always scrollable.
  // Candles need more horizontal space than line points.
  const minBarPx  = isCandle ? 12 : 4;
  const chartWidth = Math.max(900, chartData.length * minBarPx);

  const axisProps = {
    tick:     { fill: "rgba(255,255,255,0.3)", fontSize: 10 },
    tickLine: false as const,
    axisLine: false as const,
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

  // ── Chart render ────────────────────────────────────────────────────────────

  function renderChart() {
    if (loading) {
      return (
        <div style={{ height: chartPxHeight }}>
          <Skeleton className="w-full h-full bg-white/10 rounded-lg" />
        </div>
      );
    }

    const shared = { data: chartData, margin: { top: 4, right: 8, left: 0, bottom: 0 } };

    // Show ~10 evenly-spaced x-axis labels regardless of total point count.
    const tickInterval = Math.max(1, Math.floor(chartData.length / 10)) - 1;

    const xAxis = <XAxis dataKey="time" {...axisProps} interval={tickInterval} minTickGap={50} />;
    const yAxis = (
      <YAxis
        domain={[minP, maxP]}
        {...axisProps}
        tickFormatter={(v) => `$${v.toFixed(prec)}`}
        width={78}
      />
    );
    const grid = <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />;

    // Scrollable wrapper — plain div gives us direct control of scrollLeft.
    const wrap = (inner: React.ReactNode) => (
      <div
        ref={scrollRef}
        className="overflow-x-auto w-full rounded-lg"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.15) transparent" }}
      >
        <div style={{ width: chartWidth, height: chartPxHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            {inner as React.ReactElement}
          </ResponsiveContainer>
        </div>
      </div>
    );

    if (chartType === "line") {
      return wrap(
        <LineChart {...shared}>
          {grid}{xAxis}{yAxis}
          <Tooltip {...tooltipStyle} formatter={(v) => [`$${Number(v).toFixed(prec)}`, "CKB"]} />
          <Line
            type="monotone" dataKey="price" stroke="#22d3ee"
            strokeWidth={1.5} dot={false} activeDot={{ r: 3, fill: "#22d3ee" }}
          />
        </LineChart>
      );
    }

    if (chartType === "area") {
      return wrap(
        <AreaChart {...shared}>
          <defs>
            <linearGradient id="ckbGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#22d3ee" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#22d3ee" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {grid}{xAxis}{yAxis}
          <Tooltip {...tooltipStyle} formatter={(v) => [`$${Number(v).toFixed(prec)}`, "CKB"]} />
          <Area
            type="monotone" dataKey="price" stroke="#22d3ee"
            strokeWidth={1.5} fill="url(#ckbGrad)" dot={false}
            activeDot={{ r: 3, fill: "#22d3ee" }}
          />
        </AreaChart>
      );
    }

    // ── Candlestick ────────────────────────────────────────────────────────────
    // Re-create the shape factory on every render so it closes over fresh minP/maxP.
    const candleShape = makeCandlestickShape(minP, maxP);

    return wrap(
      <ComposedChart {...shared}>
        {grid}{xAxis}
        <YAxis
          domain={[minP, maxP]}
          {...axisProps}
          tickFormatter={(v) => `$${v.toFixed(prec)}`}
          width={78}
        />
        <Tooltip content={<CandleTooltip prec={prec} active={false} payload={[]} label={""} />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
        <Bar
          dataKey="high"
          shape={candleShape as ActiveShape<BarShapeProps, SVGPathElement>}
          isAnimationActive={false}
          fill="transparent"
          stroke="transparent"
        />
      </ComposedChart>
    );
  }

  // ─── Main render ─────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      style={isFullscreen
        ? { height: "100vh", background: "#0d0d1a", padding: "24px", display: "flex", flexDirection: "column" }
        : undefined}
    >
      <Card
        className="bg-white/5 border-white/10 text-white"
        style={isFullscreen ? { flex: 1, display: "flex", flexDirection: "column" } : undefined}
      >
        <CardHeader className="pb-2">
          {/* Row 1: title + price + controls */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base font-semibold text-white/80">CKB / USD</CardTitle>

            <div className="flex items-center gap-2 flex-wrap">
              {loading && !refetching ? (
                <Skeleton className="h-6 w-24 bg-white/10" />
              ) : error ? (
                <Badge variant="destructive" className="text-xs max-w-[160px] truncate">{error}</Badge>
              ) : (
                <div className="flex items-center gap-1.5">
                  <TrendIcon className={`w-4 h-4 ${trendColor}`} />
                  <span className="text-lg font-bold text-cyan-300">${currentPrice?.toFixed(prec)}</span>
                </div>
              )}

              <Badge variant="outline" className="text-[10px] border-white/20 text-white/40">CoinGecko</Badge>

              <button
                onClick={handleManualRefetch}
                disabled={refetching || loading}
                title="Refetch"
                className="flex items-center justify-center w-7 h-7 rounded-md border border-white/10 bg-white/5 hover:bg-white/10 text-white/50 hover:text-white transition-colors disabled:opacity-40"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refetching ? "animate-spin" : ""}`} />
              </button>

              <button
                onClick={toggleFullscreen}
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                className="flex items-center justify-center w-7 h-7 rounded-md border border-white/10 bg-white/5 hover:bg-white/10 text-white/50 hover:text-white transition-colors"
              >
                {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Row 2: chart type + duration */}
          <div className="flex items-center gap-2 flex-wrap mt-2">
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

        <CardContent
          className="pt-0"
          style={isFullscreen ? { flex: 1, display: "flex", flexDirection: "column" } : undefined}
        >
          {renderChart()}
          {!loading && (
            <p className="text-[10px] text-white/20 mt-1.5 text-right">
              {cfg.description} · {chartData.length} {isCandle ? "candles" : "points"}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
