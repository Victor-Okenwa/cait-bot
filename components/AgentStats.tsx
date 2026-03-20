"use client";

import { useEffect, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Wallet, TrendingUp, TrendingDown, Repeat, BarChart3, Coins,
  ArrowDownToLine, Loader2, CheckCircle2, AlertCircle,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { AgentSettings } from "@/lib/supabase";

const POLL_INTERVAL = 10_000;

export default function AgentStats() {
  const signer = ccc.useSigner();
  const [settings, setSettings]             = useState<AgentSettings | null>(null);
  const [onChainBalance, setOnChainBalance]  = useState<number | null>(null);
  const [loading, setLoading]               = useState(true);
  const [address, setAddress]               = useState("");
  const [isRunning, setIsRunning]           = useState(false);
  const [togglePending, setTogglePending]   = useState(false);
  const [withdrawOpen, setWithdrawOpen]     = useState(false);
  const [withdrawStatus, setWithdrawStatus] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [withdrawMsg, setWithdrawMsg]       = useState("");

  useEffect(() => {
    if (!signer) { setLoading(false); return; }
    signer.getRecommendedAddress().then((a) => setAddress(a));
  }, [signer]);

  async function load(addr: string) {
    const { data } = await supabase
      .from("agent_settings")
      .select("*")
      .eq("wallet_address", addr)
      .maybeSingle();
    if (data) {
      const s = data as AgentSettings;
      setSettings(s);
      setIsRunning(s.is_running);
      const tradingAddr = s.trading_address?.address;
      if (tradingAddr) {
        fetch(`/api/settings/trading-balance?address=${encodeURIComponent(tradingAddr)}`)
          .then((r) => r.json())
          .then(({ balance_ckb }) => setOnChainBalance(balance_ckb))
          .catch(() => {});
      }
    }
    setLoading(false);
  }

  useEffect(() => {
    if (!address) return;
    load(address);
    const id = setInterval(() => load(address), POLL_INTERVAL);
    return () => clearInterval(id);
  }, [address]);

  // ── Toggle handler — uses the server API (service role) to bypass RLS ────
  async function handleToggle(checked: boolean) {
    if (!address || togglePending) return;
    setTogglePending(true);
    setIsRunning(checked); // optimistic
    try {
      const res = await fetch(
        `/api/settings?wallet=${encodeURIComponent(address)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_running: checked }),
        }
      );
      if (!res.ok) {
        // Rollback on failure
        setIsRunning(!checked);
      } else {
        setSettings((prev) => prev ? { ...prev, is_running: checked } : prev);
      }
    } catch {
      setIsRunning(!checked);
    } finally {
      setTogglePending(false);
    }
  }

  // ── Withdraw handlers ─────────────────────────────────────────────────────
  async function handleWithdraw() {
    if (!address) return;
    setWithdrawStatus("pending");
    setWithdrawMsg("");
    try {
      const res = await fetch("/api/settings/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet_address: address }),
      });
      const json = await res.json();
      if (!res.ok) {
        setWithdrawStatus("error");
        setWithdrawMsg(json.error ?? "Withdrawal failed.");
      } else {
        setWithdrawStatus("done");
        setWithdrawMsg(
          json.tx_hash
            ? `Funds sent. Tx: ${json.tx_hash.slice(0, 18)}…`
            : json.message ?? "Withdrawal complete."
        );
        setSettings((prev) => prev ? { ...prev, is_running: false, total_capital: 0, capital_in_trading: 0 } : prev);
        setIsRunning(false);
        setOnChainBalance(null);
      }
    } catch {
      setWithdrawStatus("error");
      setWithdrawMsg("Network error. Please try again.");
    }
  }

  function handleWithdrawOpenChange(open: boolean) {
    setWithdrawOpen(open);
    if (!open) {
      setWithdrawStatus("idle");
      setWithdrawMsg("");
    }
  }

  // ── Validation for the toggle ─────────────────────────────────────────────
  // Agent can only run if: trading wallet has funds AND max_per_trade < total_capital
  const hasBalance    = (onChainBalance ?? 0) > 0;
  const maxBelowTotal = settings
    ? settings.max_per_trade < settings.total_capital
    : false;
  const canRun = !!settings && hasBalance && maxBelowTotal;

  const disabledReason = !settings
    ? "Save your settings first."
    : !hasBalance
    ? "Deposit funds into your trading wallet first."
    : !maxBelowTotal
    ? "Max per trade must be less than total capital."
    : null;

  // ── Derived stats ─────────────────────────────────────────────────────────
  const totalTrades = (settings?.win_count ?? 0) + (settings?.loss_count ?? 0);
  const winRate     = totalTrades > 0 ? ((settings?.win_count ?? 0) / totalTrades) * 100 : null;
  const lossRate    = totalTrades > 0 ? ((settings?.loss_count ?? 0) / totalTrades) * 100 : null;
  const pnlPositive = (settings?.total_pnl_ckb ?? 0) >= 0;

  if (!signer) {
    return (
      <Card className="bg-white/5 border-white/10 text-white">
        <CardContent className="py-5">
          <p className="text-sm text-white/30 text-center">Connect wallet to view agent stats.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-white/5 border-white/10 text-white">
      <CardHeader className="pb-3">
        {/* Title row */}
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm text-white/80 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-cyan-400" />
            Agent Stats
          </CardTitle>
          <Badge variant="outline" className="text-[10px] border-white/20 text-white/30">
            Live · 10s
          </Badge>
        </div>

        {/* Toggle row — only shown once settings are loaded */}
        {!loading && (
          <div className="flex items-center justify-between pt-2 mt-1 border-t border-white/10">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-white/60">
                {isRunning ? "Agent is running" : "Agent is stopped"}
              </span>
              {!isRunning && disabledReason && (
                <span className="text-[10px] text-white/30 leading-tight">{disabledReason}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {togglePending && <Loader2 className="w-3 h-3 animate-spin text-white/30" />}
              <Switch
                checked={isRunning}
                onCheckedChange={handleToggle}
                disabled={togglePending || (!isRunning && !canRun)}
                className="data-[state=checked]:bg-cyan-500"
              />
              <Badge
                variant="outline"
                className={
                  isRunning
                    ? "border-emerald-400/40 text-emerald-400 text-[10px]"
                    : "border-white/20 text-white/30 text-[10px]"
                }
              >
                {isRunning ? "LIVE" : "OFF"}
              </Badge>
            </div>
          </div>
        )}
      </CardHeader>

      <CardContent className="pt-0">
        {loading ? (
          <div className="grid grid-cols-2 gap-3">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-16 bg-white/10 rounded-xl" />
            ))}
          </div>
        ) : !settings ? (
          <p className="text-sm text-white/30 text-center py-2">
            No settings saved yet.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3">

            <StatTile
              icon={<Wallet className="w-3.5 h-3.5 text-cyan-400" />}
              label="Total Capital"
              value={`${(settings.total_capital ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CKB`}
              sub={onChainBalance !== null && onChainBalance > 0
                ? `${onChainBalance.toFixed(2)} CKB on-chain`
                : "available to trade"
              }
              color="text-cyan-300"
            />

            <StatTile
              icon={<Coins className="w-3.5 h-3.5 text-purple-400" />}
              label="Capital in Trade"
              value={`${(settings.capital_in_trading ?? 0).toFixed(2)} CKB`}
              sub={
                settings.last_buy_price
                  ? `bought @ $${settings.last_buy_price.toFixed(6)}`
                  : "no open position"
              }
              color="text-purple-300"
            />

            <StatTile
              icon={<TrendingUp className="w-3.5 h-3.5 text-emerald-400" />}
              label="Win Rate"
              value={winRate !== null ? `${winRate.toFixed(1)}%` : "—"}
              sub={`${settings.win_count ?? 0} winning trades`}
              color="text-emerald-400"
            />

            <StatTile
              icon={<TrendingDown className="w-3.5 h-3.5 text-red-400" />}
              label="Loss Rate"
              value={lossRate !== null ? `${lossRate.toFixed(1)}%` : "—"}
              sub={`${settings.loss_count ?? 0} losing trades`}
              color="text-red-400"
            />

            <StatTile
              icon={<Repeat className="w-3.5 h-3.5 text-orange-400" />}
              label="Martingale Used"
              value={`${settings.martingale_count ?? 0}×`}
              sub="doubled-size trades"
              color="text-orange-400"
            />

            <StatTile
              icon={
                pnlPositive
                  ? <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                  : <TrendingDown className="w-3.5 h-3.5 text-red-400" />
              }
              label="Total P&L"
              value={`${pnlPositive ? "+" : ""}${(settings.total_pnl_ckb ?? 0).toFixed(2)} CKB`}
              sub={`across ${totalTrades} closed trades`}
              color={pnlPositive ? "text-emerald-400" : "text-red-400"}
            />

          </div>
        )}

        {/* ── Withdraw button ── */}
        {settings && (
          <div className="mt-3 pt-3 border-t border-white/10">
            <Dialog open={withdrawOpen} onOpenChange={handleWithdrawOpenChange}>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full border-orange-500/30 text-orange-400 hover:bg-orange-500/10 hover:text-orange-300 hover:border-orange-400/50 gap-2 text-xs"
                >
                  <ArrowDownToLine className="w-3.5 h-3.5" />
                  Withdraw All Funds
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-zinc-900 border-white/10 text-white max-w-sm">
                <DialogHeader>
                  <DialogTitle className="text-white flex items-center gap-2">
                    <ArrowDownToLine className="w-4 h-4 text-orange-400" />
                    Withdraw All Funds
                  </DialogTitle>
                  <DialogDescription className="text-white/50 text-sm leading-relaxed">
                    This will transfer all capital from your trading wallet back to your owner
                    address. If the agent is currently running, it will be stopped automatically.
                  </DialogDescription>
                </DialogHeader>

                {withdrawStatus === "error" && (
                  <div className="flex items-center gap-2 text-red-400 text-xs bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {withdrawMsg}
                  </div>
                )}
                {withdrawStatus === "done" && (
                  <div className="flex items-center gap-2 text-emerald-400 text-xs bg-emerald-400/10 border border-emerald-400/20 rounded-lg px-3 py-2">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    {withdrawMsg}
                  </div>
                )}

                <DialogFooter className="gap-2 sm:gap-2">
                  {withdrawStatus !== "done" && (
                    <Button
                      variant="outline"
                      onClick={() => handleWithdrawOpenChange(false)}
                      disabled={withdrawStatus === "pending"}
                      className="border-white/10 text-white/60 hover:text-white hover:bg-white/5"
                    >
                      Cancel
                    </Button>
                  )}
                  {withdrawStatus === "done" ? (
                    <Button
                      onClick={() => handleWithdrawOpenChange(false)}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white"
                    >
                      Done
                    </Button>
                  ) : (
                    <Button
                      onClick={handleWithdraw}
                      disabled={withdrawStatus === "pending"}
                      className="bg-orange-600 hover:bg-orange-500 text-white gap-2"
                    >
                      {withdrawStatus === "pending" && (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      )}
                      {withdrawStatus === "pending" ? "Processing…" : "Confirm Withdrawal"}
                    </Button>
                  )}
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Tile sub-component ───────────────────────────────────────────────────────

function StatTile({
  icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[10px] text-white/40 font-medium uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <p className={`text-base font-bold font-mono leading-none ${color}`}>
        {value}
      </p>
      <p className="text-[10px] text-white/30 leading-none truncate">{sub}</p>
    </div>
  );
}
