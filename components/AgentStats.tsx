"use client";

import { useEffect, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Wallet, TrendingUp, TrendingDown, Repeat, BarChart3, Coins,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { AgentSettings } from "@/lib/supabase";

const POLL_INTERVAL = 10_000;

export default function AgentStats() {
  const signer = ccc.useSigner();
  const [settings, setSettings]           = useState<AgentSettings | null>(null);
  const [onChainBalance, setOnChainBalance] = useState<number | null>(null);
  const [loading, setLoading]             = useState(true);
  const [address, setAddress]             = useState("");

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
      setSettings(data as AgentSettings);
      // Fetch on-chain balance from the trading wallet
      const tradingAddr = (data as AgentSettings).trading_address?.address;
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

  if (!signer) {
    return (
      <Card className="bg-white/5 border-white/10 text-white">
        <CardContent className="py-5">
          <p className="text-sm text-white/30 text-center">Connect wallet to view agent stats.</p>
        </CardContent>
      </Card>
    );
  }

  // ── Derived stats ───────────────────────────────────────────────────────────
  const totalTrades  = (settings?.win_count ?? 0) + (settings?.loss_count ?? 0);
  const winRate      = totalTrades > 0 ? ((settings?.win_count ?? 0) / totalTrades) * 100 : null;
  const lossRate     = totalTrades > 0 ? ((settings?.loss_count ?? 0) / totalTrades) * 100 : null;
  const pnlPositive  = (settings?.total_pnl_ckb ?? 0) >= 0;

  return (
    <Card className="bg-white/5 border-white/10 text-white">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-sm text-white/80 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-cyan-400" />
          Agent Stats
        </CardTitle>
        <Badge
          variant="outline"
          className="text-[10px] border-white/20 text-white/30"
        >
          Live · 10s
        </Badge>
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

            {/* Total capital — DB value (synced from on-chain by the agent) */}
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

            {/* Capital in trading */}
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

            {/* Win rate */}
            <StatTile
              icon={<TrendingUp className="w-3.5 h-3.5 text-emerald-400" />}
              label="Win Rate"
              value={winRate !== null ? `${winRate.toFixed(1)}%` : "—"}
              sub={`${settings.win_count ?? 0} winning trades`}
              color="text-emerald-400"
            />

            {/* Loss rate */}
            <StatTile
              icon={<TrendingDown className="w-3.5 h-3.5 text-red-400" />}
              label="Loss Rate"
              value={lossRate !== null ? `${lossRate.toFixed(1)}%` : "—"}
              sub={`${settings.loss_count ?? 0} losing trades`}
              color="text-red-400"
            />

            {/* Martingale count */}
            <StatTile
              icon={<Repeat className="w-3.5 h-3.5 text-orange-400" />}
              label="Martingale Used"
              value={`${settings.martingale_count ?? 0}×`}
              sub="doubled-size trades"
              color="text-orange-400"
            />

            {/* Total P&L */}
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
