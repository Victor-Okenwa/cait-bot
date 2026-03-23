"use client";
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { useCallback, useEffect, useRef, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    ExternalLink,
    History,
    TrendingUp,
    TrendingDown,
    Trash2,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    ChevronDown,
    ChevronsUpDown,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type TradeRow = {
    id: string;
    timestamp: string;
    type: string;
    amount: number;
    price: number;
    reason: string | null;
    martingale: boolean;
    tx_hash?: string | null;
    explorer_link?: string | null;
    pnl_ckb?: number | null;
    pnl_usd?: number | null;
    profit_tx_hash?: string | null;
    wallet_address: string;
};

type SortDir = "asc" | "desc" | null;
type SortCol = "timestamp" | "type" | "amount" | "price" | "pnl_ckb";

const PAGE_SIZES = [25, 50, 100] as const;
const POLL_INTERVAL = 15_000;

const TYPE_STYLES: Record<string, string> = {
    buy: "bg-emerald-400/15 text-emerald-400 border-emerald-400/30",
    sell: "bg-red-400/15 text-red-400 border-red-400/30",
    hold: "bg-yellow-400/15 text-yellow-400 border-yellow-400/30",
    wait: "bg-white/10 text-white/40 border-white/20",
};

function SortIcon({ col, sortCol, sortDir }: { col: SortCol; sortCol: SortCol; sortDir: SortDir }) {
    if (col !== sortCol || sortDir === null) return <ChevronsUpDown className="w-3 h-3 opacity-30" />;
    return sortDir === "asc"
        ? <ChevronUp className="w-3 h-3 text-cyan-400" />
        : <ChevronDown className="w-3 h-3 text-cyan-400" />;
}

function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function TradeLog() {
    const signer = ccc.useSigner();
    const [address, setAddress] = useState("");

    const [trades, setTrades] = useState<TradeRow[]>([]);
    const [totalCount, setTotalCount] = useState(0);
    const [loading, setLoading] = useState(true);
    const [deleting, setDeleting] = useState(false);

    const [page, setPage] = useState(0); // 0-indexed
    const [pageSize, setPageSize] = useState<typeof PAGE_SIZES[number]>(25);

    const [sortCol, setSortCol] = useState<SortCol>("timestamp");
    const [sortDir, setSortDir] = useState<SortDir>("desc");

    const [selected, setSelected] = useState<Set<string>>(new Set());

    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    // Resolve address
    useEffect(() => {
        if (!signer) { setLoading(false); return; }
        signer.getRecommendedAddress().then(setAddress);
    }, [signer]);

    const fetchTrades = useCallback(async (addr: string, pg: number, ps: number, sc: SortCol, sd: SortDir) => {
        const offset = pg * ps;
        const dir = sd ?? "desc";
        const res = await fetch(
            `/api/trades?wallet=${encodeURIComponent(addr)}&limit=${ps}&offset=${offset}&sort=${sc}&dir=${dir}`
        );
        if (!res.ok) { setLoading(false); return; }
        const json = await res.json();
        setTrades(json.data ?? []);
        setTotalCount(json.count ?? 0);
        setLoading(false);
    }, []);

    // Poll
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    useEffect(() => {
        if (!address) return;
        setLoading(true);
        fetchTrades(address, page, pageSize, sortCol, sortDir);
        pollRef.current = setInterval(
            () => fetchTrades(address, page, pageSize, sortCol, sortDir),
            POLL_INTERVAL
        );
        return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }, [address, page, pageSize, sortCol, sortDir, fetchTrades]);

    // Reset page when sort/size changes (but not on address change — handled above)
    function handleSortClick(col: SortCol) {
        setSelected(new Set());
        if (col === sortCol) {
            // cycle: desc → asc → null (DB default, stored as desc)
            setSortDir(d => d === "desc" ? "asc" : d === "asc" ? null : "desc");
        } else {
            setSortCol(col);
            setSortDir("desc");
        }
        setPage(0);
    }

    function handlePageSizeChange(ps: typeof PAGE_SIZES[number]) {
        setPageSize(ps);
        setPage(0);
        setSelected(new Set());
    }

    // Selection
    const pageIds = trades.map(t => t.id);
    const allPageSelected = pageIds.length > 0 && pageIds.every(id => selected.has(id));
    const somePageSelected = pageIds.some(id => selected.has(id));

    function toggleAll() {
        setSelected(prev => {
            const next = new Set(prev);
            if (allPageSelected) {
                pageIds.forEach(id => next.delete(id));
            } else {
                pageIds.forEach(id => next.add(id));
            }
            return next;
        });
    }

    function toggleRow(id: string) {
        setSelected(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    }

    // Delete
    async function handleDelete() {
        if (!address || selected.size === 0) return;
        setDeleting(true);
        const ids = Array.from(selected);
        const res = await fetch("/api/trades", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wallet: address, ids }),
        });
        if (res.ok) {
            setSelected(new Set());
            // Re-clamp page if we deleted enough rows to shrink total pages
            const newTotal = totalCount - ids.length;
            const newPages = Math.max(1, Math.ceil(newTotal / pageSize));
            const clampedPage = Math.min(page, newPages - 1);
            setPage(clampedPage);
            await fetchTrades(address, clampedPage, pageSize, sortCol, sortDir);
        }
        setDeleting(false);
    }

    const thClass = "text-white/40 text-xs font-medium select-none cursor-pointer hover:text-white/70 transition-colors";

    function SortableHead({ col, label, className }: { col: SortCol; label: string; className?: string }) {
        return (
            <TableHead className={`${thClass} ${className ?? ""}`} onClick={() => handleSortClick(col)}>
                <span className="flex items-center gap-1">
                    {label}
                    <SortIcon col={col} sortCol={sortCol} sortDir={sortDir} />
                </span>
            </TableHead>
        );
    }

    return (
        <Card className="bg-white/5 border-white/10 text-white">
            <CardHeader className="flex flex-row items-center justify-between pb-3 flex-wrap gap-2">
                <CardTitle className="text-base text-white/80 flex items-center gap-2">
                    <History className="w-4 h-4 text-cyan-400" />
                    Trade Log
                </CardTitle>
                <div className="flex items-center gap-2 flex-wrap">
                    {selected.size > 0 && (
                        <button
                            onClick={handleDelete}
                            disabled={deleting}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 disabled:opacity-50 transition-colors"
                        >
                            <Trash2 className="w-3 h-3" />
                            Delete ({selected.size})
                        </button>
                    )}
                    <Badge variant="outline" className="text-[10px] border-white/20 text-white/40">
                        {totalCount} trades
                    </Badge>
                    <Badge variant="outline" className="text-[10px] border-white/20 text-white/40">
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
                        {[...Array(5)].map((_, i) => (
                            <Skeleton key={i} className="h-10 w-full bg-white/10" />
                        ))}
                    </div>
                ) : trades.length === 0 ? (
                    <p className="text-sm text-white/30 px-6 pb-6">
                        No trades yet — start the agent to begin.
                    </p>
                ) : (
                    <>
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow className="border-white/10 hover:bg-transparent">
                                        {/* Select-all checkbox */}
                                        <TableHead className="w-8 pl-4">
                                            <Checkbox
                                                checked={allPageSelected || (somePageSelected ? "indeterminate" : false)}
                                                onCheckedChange={toggleAll}
                                                className="border-white/30 data-[state=checked]:bg-cyan-500 data-[state=checked]:border-cyan-500 data-[state=indeterminate]:bg-cyan-500/40 data-[state=indeterminate]:border-cyan-500"
                                            />
                                        </TableHead>
                                        <SortableHead col="timestamp" label="Time" className="w-28" />
                                        <SortableHead col="type" label="Type" className="w-16" />
                                        <SortableHead col="amount" label="Amount (CKB)" className="text-right w-28" />
                                        <SortableHead col="price" label="Price (USD)" className="text-right w-28" />
                                        <TableHead className="text-white/40 text-xs font-medium">AI Reason</TableHead>
                                        <TableHead className="text-white/40 text-xs font-medium w-20 text-center">Martingale</TableHead>
                                        <SortableHead col="pnl_ckb" label="P&L (CKB)" className="text-right w-32" />
                                        <TableHead className="text-white/40 text-xs font-medium w-16 text-center">TX</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {trades.map((trade) => (
                                        <TableRow
                                            key={trade.id}
                                            className={`border-white/5 hover:bg-white/5 transition-colors ${selected.has(trade.id) ? "bg-white/5" : ""}`}
                                        >
                                            <TableCell className="pl-4 py-2.5">
                                                <Checkbox
                                                    checked={selected.has(trade.id)}
                                                    onCheckedChange={() => toggleRow(trade.id)}
                                                    className="border-white/30 data-[state=checked]:bg-cyan-500 data-[state=checked]:border-cyan-500"
                                                />
                                            </TableCell>
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
                                                    className={`text-[10px] uppercase font-bold ${TYPE_STYLES[trade.type] ?? TYPE_STYLES.wait}`}
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
                                                <Tooltip>
                                                    <TooltipTrigger>
                                                        <p className="text-xs text-white/60 truncate text-left">
                                                            {trade.reason ?? "—"}
                                                        </p>
                                                    </TooltipTrigger>
                                                    <TooltipContent side="top">
                                                        {trade.reason ?? "—"}
                                                    </TooltipContent>
                                                </Tooltip>
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
                                            <TableCell className="py-2.5 text-right">
                                                {trade.type === "sell" && trade.pnl_ckb != null ? (
                                                    <div className="flex flex-col items-end gap-0.5">
                                                        <div className={`flex items-center gap-1 text-sm font-mono font-semibold ${trade.pnl_ckb >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                                            {trade.pnl_ckb >= 0
                                                                ? <TrendingUp className="w-3 h-3" />
                                                                : <TrendingDown className="w-3 h-3" />}
                                                            {trade.pnl_ckb >= 0 ? "+" : ""}{trade.pnl_ckb.toFixed(2)}
                                                        </div>
                                                        {trade.pnl_usd != null && (
                                                            <span className={`text-[10px] font-mono ${trade.pnl_usd >= 0 ? "text-emerald-400/60" : "text-red-400/60"}`}>
                                                                {trade.pnl_usd >= 0 ? "+" : ""}${trade.pnl_usd.toFixed(4)}
                                                            </span>
                                                        )}
                                                        {trade.profit_tx_hash && (
                                                            <a
                                                                href={`https://testnet.explorer.nervos.org/transaction/${trade.profit_tx_hash}`}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="text-[10px] text-cyan-400/60 hover:text-cyan-300 flex items-center gap-0.5"
                                                            >
                                                                <ExternalLink className="w-2.5 h-2.5" />
                                                                payout
                                                            </a>
                                                        )}
                                                    </div>
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
                                                        className="inline-flex items-center justify-center text-cyan-400 hover:text-cyan-300 transition-colors"
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

                        {/* Pagination bar */}
                        <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/10 flex-wrap gap-2">
                            {/* Page size selector */}
                            <div className="flex items-center gap-2 text-xs text-white/40">
                                <span>Rows</span>
                                {PAGE_SIZES.map(ps => (
                                    <button
                                        key={ps}
                                        onClick={() => handlePageSizeChange(ps)}
                                        className={`px-2 py-0.5 rounded text-xs transition-colors ${ps === pageSize ? "bg-white/15 text-white/80" : "hover:bg-white/10 text-white/40"}`}
                                    >
                                        {ps}
                                    </button>
                                ))}
                            </div>

                            {/* Page nav */}
                            <div className="flex items-center gap-2 text-xs text-white/50">
                                <button
                                    onClick={() => setPage(p => Math.max(0, p - 1))}
                                    disabled={page === 0}
                                    className="p-1 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                >
                                    <ChevronLeft className="w-3.5 h-3.5" />
                                </button>
                                <span>Page {page + 1} of {totalPages}</span>
                                <button
                                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                                    disabled={page >= totalPages - 1}
                                    className="p-1 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                >
                                    <ChevronRight className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    </>
                )}
            </CardContent>
        </Card>
    );
}
