"use client";

import { useEffect, useState } from "react";
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

type PricePoint = {
    time: string;
    price: number;
};

const MAX_POINTS = 30;
const POLL_INTERVAL = 60_000; // 60 seconds

export default function PriceChart() {
    const [data, setData] = useState<PricePoint[]>([]);
    const [currentPrice, setCurrentPrice] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    async function fetchPrice() {
        try {
            const res = await fetch(
                "https://api.coingecko.com/api/v3/simple/price?ids=nervos-network&vs_currencies=usd"
            );
            if (!res.ok) throw new Error("CoinGecko error");
            const json = await res.json();
            const price: number = json["nervos-network"]?.usd;
            if (!price) throw new Error("No price returned");

            const point: PricePoint = {
                time: new Date().toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                }),
                price,
            };

            setCurrentPrice(price);
            setData((prev) => {
                const updated = [...prev, point];
                return updated.length > MAX_POINTS
                    ? updated.slice(updated.length - MAX_POINTS)
                    : updated;
            });
            setError(null);
        } catch (err: any) {
            setError(err.message ?? "Failed to fetch price");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        fetchPrice();
        const id = setInterval(fetchPrice, POLL_INTERVAL);
        return () => clearInterval(id);
    }, []);

    const trend = (() => {
        if (data.length < 2) return "flat";
        const delta = data[data.length - 1].price - data[data.length - 2].price;
        if (delta > 0) return "up";
        if (delta < 0) return "down";
        return "flat";
    })();

    const TrendIcon =
        trend === "up"
            ? TrendingUp
            : trend === "down"
                ? TrendingDown
                : Minus;

    const trendColor =
        trend === "up"
            ? "text-emerald-400"
            : trend === "down"
                ? "text-red-400"
                : "text-white/40";

    const minPrice = data.length
        ? Math.min(...data.map((d) => d.price)) * 0.999
        : 0;
    const maxPrice = data.length
        ? Math.max(...data.map((d) => d.price)) * 1.001
        : 1;

    return (
        <Card className="bg-white/5 border-white/10 text-white">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base font-semibold text-white/80">
                    CKB / USD — Live Price
                </CardTitle>
                <div className="flex items-center gap-2">
                    {loading ? (
                        <Skeleton className="h-6 w-24 bg-white/10" />
                    ) : error ? (
                        <Badge variant="destructive" className="text-xs">
                            {error}
                        </Badge>
                    ) : (
                        <div className="flex items-center gap-1.5">
                            <TrendIcon className={`w-4 h-4 ${trendColor}`} />
                            <span className="text-lg font-bold text-cyan-300">
                                ${currentPrice?.toFixed(6)}
                            </span>
                        </div>
                    )}
                    <Badge
                        variant="outline"
                        className="text-[10px] border-white/20 text-white/40"
                    >
                        CoinGecko
                    </Badge>
                </div>
            </CardHeader>

            <CardContent className="pt-0">
                {loading ? (
                    <Skeleton className="h-48 w-full bg-white/10 rounded-lg" />
                ) : (
                    <ResponsiveContainer width="100%" height={200}>
                        <LineChart
                            data={data}
                            margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                        >
                            <CartesianGrid
                                strokeDasharray="3 3"
                                stroke="rgba(255,255,255,0.06)"
                            />
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
                                tickFormatter={(v) => `$${v.toFixed(5)}`}
                                width={72}
                            />
                            <Tooltip
                                contentStyle={{
                                    background: "#1a1a2e",
                                    border: "1px solid rgba(255,255,255,0.1)",
                                    borderRadius: 8,
                                    color: "#fff",
                                    fontSize: 12,
                                }}
                                formatter={(value: number) => [
                                    `$${value.toFixed(6)}`,
                                    "CKB Price",
                                ]}
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
                <p className="text-[10px] text-white/20 mt-2 text-right">
                    Updates every 60s · Last {data.length} readings
                </p>
            </CardContent>
        </Card>
    );
}
