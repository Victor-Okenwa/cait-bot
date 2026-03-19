"use client";

import { useEffect, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { ExternalLink, History } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Trade } from "@/lib/supabase";

const POLL_INTERVAL = 15_000; // 15 seconds

type TradeRow = Trade & { id: string; timestamp: string };

const TYPE_STYLES: Record<string, string> = {
    buy: "bg-emerald-400/15 text-emerald-400 border-emerald-400/30",
    sell: "bg-red-400/15 text-red-400 border-red-400/30",
    hold: "bg-yellow-400/15 text-yellow-400 border-yellow-400/30",
    wait: "bg-white/10 text-white/40 border-white/20",
};

export default function TradeLog() {
    const signer = ccc.useSigner();
    const [address, setAddress] = useState<string>("");
    const [trades, setTrades] = useState<TradeRow[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!signer) {
            setLoading(false);
            return;
        }
        signer.getRecommendedAddress().then((addr) => setAddress(addr));
    }, [signer]);

    async function fetchTrades(addr: string) {
        const { data, error } = await supabase
            .from("trades")
            .select("*")
            .eq("wallet_address", addr)
            .order("timestamp", { ascending: false })
            .limit(50);

        if (!error && data) {
            setTrades(data as TradeRow[]);
        }
        setLoading(false);
    }

    useEffect(() => {
        if (!address) return;
        fetchTrades(address);
        const id = setInterval(() => fetchTrades(address), POLL_INTERVAL);
        return () => clearInterval(id);
    }, [address]);

    function formatTime(iso: string) {
        return new Date(iso).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    }

    function formatDate(iso: string) {
        return new Date(iso).toLocaleDateString([], {
            month: "short",
            day: "numeric",
        });
    }

    return (
        <Card className="bg-white/5 border-white/10 text-white">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-base text-white/80 flex items-center gap-2">
                    <History className="w-4 h-4 text-cyan-400" />
                    Trade Log
                </CardTitle>
                <div className="flex items-center gap-2">
                    <Badge
                        variant="outline"
                        className="text-[10px] border-white/20 text-white/40"
                    >
                        {trades.length} trades
                    </Badge>
                    <Badge
                        variant="outline"
                        className="text-[10px] border-white/20 text-white/40"
                    >
                        Live · 15s
                    </Badge>
                </div>
            </CardHeader>

            <CardContent className="p-0">
                {!signer ? (
                    <p className="text-sm text-white/40 px-6 pb-6">
                        Connect your wallet to view trade history.
                    </p>
                ) : loading ? (
                    <div className="space-y-2 px-6 pb-6">
                        {[...Array(4)].map((_, i) => (
                            <Skeleton key={i} className="h-10 w-full bg-white/10" />
                        ))}
                    </div>
                ) : trades.length === 0 ? (
                    <p className="text-sm text-white/30 px-6 pb-6">
                        No trades yet — start the agent to begin.
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow className="border-white/10 hover:bg-transparent">
                                    <TableHead className="text-white/40 text-xs font-medium w-28">
                                        Time
                                    </TableHead>
                                    <TableHead className="text-white/40 text-xs font-medium w-16">
                                        Type
                                    </TableHead>
                                    <TableHead className="text-white/40 text-xs font-medium text-right w-28">
                                        Amount (CKB)
                                    </TableHead>
                                    <TableHead className="text-white/40 text-xs font-medium text-right w-28">
                                        Price (USD)
                                    </TableHead>
                                    <TableHead className="text-white/40 text-xs font-medium">
                                        AI Reason
                                    </TableHead>
                                    <TableHead className="text-white/40 text-xs font-medium w-20 text-center">
                                        Martingale
                                    </TableHead>
                                    <TableHead className="text-white/40 text-xs font-medium w-16 text-center">
                                        TX
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {trades.map((trade) => (
                                    <TableRow
                                        key={trade.id}
                                        className="border-white/5 hover:bg-white/5 transition-colors"
                                    >
                                        <TableCell className="py-2.5">
                                            <div className="text-xs text-white/70 font-mono leading-none">
                                                {formatTime(trade.timestamp)}
                                            </div>
                                            <div className="text-[10px] text-white/30 mt-0.5">
                                                {formatDate(trade.timestamp)}
                                            </div>
                                        </TableCell>

                                        <TableCell className="py-2.5">
                                            <Badge
                                                variant="outline"
                                                className={`text-[10px] uppercase font-bold ${TYPE_STYLES[trade.type] ?? TYPE_STYLES.wait
                                                    }`}
                                            >
                                                {trade.type}
                                            </Badge>
                                        </TableCell>

                                        <TableCell className="py-2.5 text-right font-mono text-sm text-white/80">
                                            {trade.amount > 0 ? trade.amount.toFixed(2) : "—"}
                                        </TableCell>

                                        <TableCell className="py-2.5 text-right font-mono text-sm text-cyan-300">
                                            ${trade.price.toFixed(6)}
                                        </TableCell>

                                        <TableCell className="py-2.5 max-w-xs">
                                            <p className="text-xs text-white/60 truncate">
                                                {trade.reason ?? "—"}
                                            </p>
                                        </TableCell>

                                        <TableCell className="py-2.5 text-center">
                                            {trade.martingale ? (
                                                <Badge className="bg-orange-400/20 text-orange-400 border-orange-400/30 text-[10px]">
                                                    2×
                                                </Badge>
                                            ) : (
                                                <span className="text-white/20 text-xs">—</span>
                                            )}
                                        </TableCell>

                                        <TableCell className="py-2.5 text-center">
                                            {trade.tx_hash && trade.explorer_link ? (
                                                <a
                                                    href={trade.explorer_link}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="inline-flex items-center justify-center text-cyan-400 hover:text-cyan-300
  transition-colors"
                                                    title={trade.tx_hash}
                                                >
                                                    <ExternalLink className="w-3.5 h-3.5" />
                                                </a>
                                            ) : (
                                                <span className="text-white/20 text-xs">—</span>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}