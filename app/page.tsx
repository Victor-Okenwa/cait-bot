"use client";

import WalletConnect from "@/components/WalletConnect";
import PriceChart from "@/components/PriceChart";
import AgentControls from "@/components/AgentControls";
import AgentStats from "@/components/AgentStats";
import TradeLog from "@/components/TradeLog";
import { Badge } from "@/components/ui/badge";
import { Bot, Cpu, Zap } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen bg-[#0d0d1a] text-white">
      {/* ── Header ── */}
      <header className="border-b border-white/10 bg-[#0d0d1a]/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          {/* Logo + Title */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center">
              <Bot className="w-4 h-4 text-cyan-400" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight leading-none">
                CAIT
              </h1>
              <p className="text-[10px] text-white/40 leading-none mt-0.5">
                Claw Artificial Intelligent Trader
              </p>
            </div>
            <Badge
              variant="outline"
              className="ml-2 text-[10px] border-cyan-400/30 text-cyan-400 hidden sm:flex"
            >
              Testnet
            </Badge>
          </div>

          {/* Right: status pills + wallet */}
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-1.5 text-[10px] text-white/30">
              <Cpu className="w-3 h-3" />
              Claude Opus
            </div>
            <div className="hidden sm:flex items-center gap-1.5 text-[10px] text-white/30">
              <Zap className="w-3 h-3" />
              CKB AI MCP
            </div>
            <WalletConnect />
          </div>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">

        {/* Hero banner */}
        <div className="rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/10 via-[#0d0d1a] to-purple-500/10
   px-6 py-5 flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1">
            <h2 className="text-xl font-bold text-white leading-tight">
              Automate your trading with AI
            </h2>
            <p className="text-sm text-white/50 mt-1 max-w-lg">
              CAIT monitors CKB price every 60 seconds, uses Claude to decide
              when to buy or sell within your target window, and applies
              Martingale sizing to recover from losses — all on-chain on
              CKB Testnet.
            </p>
          </div>
          <div className="flex gap-3 shrink-0">
            <Stat label="AI Model" value="Claude Opus" />
            <Stat label="Network" value="Testnet" />
            <Stat label="Strategy" value="Martingale" />
          </div>
        </div>

        {/* Price chart — full width */}
        <PriceChart />

        {/* Agent controls + Trade log — 2 col on large screens */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <AgentControls />
            <AgentStats />
        </div>

          <div className="">
            <TradeLog />
          </div>
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-white/5 mt-12 py-6">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px]
   text-white/20">
          <p>
            CAIT · Built for{" "}
            <span className="text-cyan-400/60">Claw &amp; Order Hackathon</span>{" "}
            · CKB Testnet only
          </p>
          <p>Powered by Claude Opus · CCC · CKB AI MCP · Supabase</p>
        </div>
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 min-w-[80px]">
      <p className="text-[10px] text-white/30 leading-none">{label}</p>
      <p className="text-sm font-semibold text-cyan-300 mt-1 leading-none">
        {value}
      </p>
    </div>
  );
}
