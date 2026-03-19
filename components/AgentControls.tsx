"use client";

import { useEffect, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Bot, Save, AlertCircle, CheckCircle2, Loader2,
    Eye, EyeOff, Copy, Check, Wallet2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { AgentSettings, TradingAddress } from "@/lib/supabase";

type Status = "idle" | "saving" | "saved" | "error";

const STEPS = [
    "Refunding old capital…",
    "Waiting for wallet approval…",
    "Saving settings…",
];

function stringToHex(str: string): string {
    const bytes = new TextEncoder().encode(str);
    return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function AgentControls() {
    const signer = ccc.useSigner();
    const [address, setAddress]             = useState<string>("");
    const [isRunning, setIsRunning]         = useState(false);
    const [status, setStatus]               = useState<Status>("idle");
    const [savingStep, setSavingStep]       = useState(0);
    const [errorMsg, setErrorMsg]           = useState("");
    const [loading, setLoading]             = useState(true);
    const [tradingWallet, setTradingWallet]     = useState<TradingAddress | null>(null);
    const [tradingBalance, setTradingBalance]   = useState<number | null>(null);
    const [showKey, setShowKey]                 = useState(false);
    const [copied, setCopied]                   = useState(false);

    const [form, setForm] = useState({
        likelyBuyPrice: "",
        likelySellPrice: "",
        totalCapital: "",
        maxPerTrade: "",
    });

    // ── Load address, settings, and trading wallet ────────────────────────────
    useEffect(() => {
        if (!signer) { setLoading(false); return; }

        signer.getRecommendedAddress().then(async (addr) => {
            setAddress(addr);

            // Fetch settings and trading wallet in parallel
            const [settingsRes, walletRes] = await Promise.all([
                supabase
                    .from("agent_settings")
                    .select("*")
                    .eq("wallet_address", addr)
                    .maybeSingle(),
                fetch("/api/settings/trading-wallet", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ wallet_address: addr }),
                }),
            ]);

            if (settingsRes.data) {
                const d = settingsRes.data;
                setForm({
                    likelyBuyPrice: String(d.likely_buy_price),
                    likelySellPrice: String(d.likely_sell_price),
                    totalCapital: String(d.total_capital),
                    maxPerTrade: String(d.max_per_trade),
                });
                setIsRunning(d.is_running);
            }

            if (walletRes.ok) {
                const { trading_address } = await walletRes.json();
                setTradingWallet(trading_address);
                // Fetch on-chain balance for the trading wallet
                if (trading_address?.address) {
                    fetchBalance(trading_address.address);
                }
            }

            setLoading(false);
        });
    }, [signer]);

    async function fetchBalance(address: string) {
        try {
            const res = await fetch(
                `/api/settings/trading-balance?address=${encodeURIComponent(address)}`
            );
            if (res.ok) {
                const { balance_ckb } = await res.json();
                setTradingBalance(balance_ckb);
            }
        } catch {
            // silently ignore
        }
    }

    // Poll on-chain balance every 15 seconds
    useEffect(() => {
        if (!tradingWallet?.address) return;
        const id = setInterval(() => fetchBalance(tradingWallet.address), 15_000);
        return () => clearInterval(id);
    }, [tradingWallet?.address]);

    function handleChange(field: keyof typeof form, value: string) {
        if (value !== "" && !/^\d*\.?\d*$/.test(value)) return;
        setForm((prev) => ({ ...prev, [field]: value }));
    }

    function validate(): string | null {
        const buy     = parseFloat(form.likelyBuyPrice);
        const sell    = parseFloat(form.likelySellPrice);
        const capital = parseFloat(form.totalCapital);
        const max     = parseFloat(form.maxPerTrade);

        if (!buy || !sell || !capital || !max) return "All fields are required.";
        if (buy <= 0 || sell <= 0 || capital <= 0 || max <= 0)
            return "All values must be greater than 0.";
        if (sell <= buy)   return "Sell price must be greater than buy price.";
        if (max > capital) return "Max per trade cannot exceed total capital.";
        if (capital < 61)  return "Total capital must be at least 61 CKB.";
        return null;
    }

    async function handleCopy() {
        if (!tradingWallet) return;
        await navigator.clipboard.writeText(tradingWallet.address);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    async function handleSave() {
        if (!address || !signer) return;

        const err = validate();
        if (err) { setErrorMsg(err); setStatus("error"); return; }

        if (!tradingWallet) {
            setErrorMsg("Trading wallet not ready. Please wait a moment and try again.");
            setStatus("error");
            return;
        }

        setStatus("saving");
        setErrorMsg("");
        setSavingStep(0);

        const newCapital = parseFloat(form.totalCapital);

        // ── Step 1: Refund old capital from trading wallet → user's main wallet ─
        try {
            const res = await fetch("/api/settings/recapitalize", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ wallet_address: address }),
            });
            const json = await res.json();
            if (!res.ok) {
                setErrorMsg(json.error ?? "Recapitalize failed.");
                setStatus("error");
                return;
            }
        } catch {
            setErrorMsg("Failed to contact server. Check your connection.");
            setStatus("error");
            return;
        }

        // ── Step 2: User's connected wallet sends new capital → trading wallet ──
        setSavingStep(1);
        try {
            const toScript = await ccc.Address.fromString(
                tradingWallet.address,
                signer.client
            );
            const amountShannon = ccc.fixedPointFrom(newCapital.toFixed(8));

            const tx = ccc.Transaction.from({
                outputs: [{ capacity: amountShannon, lock: toScript.script }],
                outputsData: [stringToHex(`CAIT DEPOSIT ${newCapital.toFixed(2)} CKB`)],
            });

            await tx.completeInputsByCapacity(signer);
            await tx.completeFeeBy(signer, 1000);
            await signer.sendTransaction(tx);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setErrorMsg(`Deposit transaction failed: ${msg}`);
            setStatus("error");
            return;
        }

        // ── Step 3: Upsert settings + reset all stats ────────────────────────────
        setSavingStep(2);
        const payload: AgentSettings & Record<string, unknown> = {
            wallet_address: address,
            likely_buy_price: parseFloat(form.likelyBuyPrice),
            likely_sell_price: parseFloat(form.likelySellPrice),
            total_capital: newCapital,
            max_per_trade: parseFloat(form.maxPerTrade),
            is_running: false,
            trading_address: tradingWallet,
            capital_in_trading: 0,
            last_buy_price: null,
            last_buy_amount: null,
            win_count: 0,
            loss_count: 0,
            martingale_count: 0,
            total_pnl_ckb: 0,
            updated_at: new Date().toISOString(),
        };

        const { error: upsertErr } = await supabase
            .from("agent_settings")
            .upsert(payload, { onConflict: "wallet_address" });

        if (upsertErr) {
            setErrorMsg(upsertErr.message);
            setStatus("error");
        } else {
            setIsRunning(false);
            setStatus("saved");
            setTimeout(() => setStatus("idle"), 3500);
        }
    }

    async function handleToggle(checked: boolean) {
        if (!address) return;
        setIsRunning(checked);
        if (status === "saved" || status === "idle") {
            await supabase
                .from("agent_settings")
                .update({ is_running: checked, updated_at: new Date().toISOString() })
                .eq("wallet_address", address);
        }
    }

    // ── Not connected ─────────────────────────────────────────────────────────
    if (!signer) {
        return (
            <Card className="bg-white/5 border-white/10 text-white">
                <CardHeader>
                    <CardTitle className="text-base text-white/80 flex items-center gap-2">
                        <Bot className="w-4 h-4 text-cyan-400" />
                        Automate your trading with AI
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-white/40">Connect your wallet to configure the agent.</p>
                </CardContent>
            </Card>
        );
    }

    if (loading) {
        return (
            <Card className="bg-white/5 border-white/10 text-white">
                <CardContent className="pt-6 space-y-3">
                    <Skeleton className="h-8 w-full bg-white/10" />
                    <Skeleton className="h-8 w-full bg-white/10" />
                    <Skeleton className="h-8 w-3/4 bg-white/10" />
                </CardContent>
            </Card>
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    return (
        <Card className="bg-white/5 border-white/10 text-white">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-base text-white/80 flex items-center gap-2">
                    <Bot className="w-4 h-4 text-cyan-400" />
                    Automate your trading with AI
                </CardTitle>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-white/40">
                        {isRunning ? "Agent running" : "Agent stopped"}
                    </span>
                    <Switch
                        checked={isRunning}
                        onCheckedChange={handleToggle}
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
            </CardHeader>

            <CardContent className="space-y-4">

                {/* ── Trading Wallet Info ── */}
                <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-2">
                    <div className="flex items-center gap-2 text-[11px] text-cyan-400/80 font-medium uppercase tracking-wide">
                        <Wallet2 className="w-3.5 h-3.5" />
                        Your Trading Wallet
                    </div>

                    {tradingWallet ? (
                        <>
                            {/* Address row */}
                            <div className="space-y-0.5">
                                <p className="text-[10px] text-white/30">Address</p>
                                <div className="flex items-center gap-1.5">
                                    <p className="text-[11px] font-mono text-cyan-300 truncate flex-1">
                                        {tradingWallet.address}
                                    </p>
                                    <button
                                        onClick={handleCopy}
                                        className="shrink-0 text-white/30 hover:text-cyan-400 transition-colors"
                                        title="Copy address"
                                    >
                                        {copied
                                            ? <Check className="w-3.5 h-3.5 text-emerald-400" />
                                            : <Copy className="w-3.5 h-3.5" />
                                        }
                                    </button>
                                </div>
                            </div>

                            {/* Private key row */}
                            <div className="space-y-0.5">
                                <p className="text-[10px] text-white/30">Private Key</p>
                                <div className="flex items-center gap-1.5">
                                    <p className="text-[11px] font-mono text-white/50 truncate flex-1">
                                        {showKey
                                            ? tradingWallet.private_key
                                            : "••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••"
                                        }
                                    </p>
                                    <button
                                        onClick={() => setShowKey((v) => !v)}
                                        className="shrink-0 text-white/30 hover:text-cyan-400 transition-colors"
                                        title={showKey ? "Hide" : "Reveal"}
                                    >
                                        {showKey
                                            ? <EyeOff className="w-3.5 h-3.5" />
                                            : <Eye className="w-3.5 h-3.5" />
                                        }
                                    </button>
                                </div>
                            </div>

                            {/* On-chain balance */}
                            <div className="flex items-center justify-between pt-0.5">
                                <p className="text-[10px] text-white/30">On-chain Balance</p>
                                <p className="text-[11px] font-mono font-semibold text-cyan-300">
                                    {tradingBalance === null
                                        ? <span className="text-white/20">loading…</span>
                                        : `${tradingBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CKB`
                                    }
                                </p>
                            </div>

                            <p className="text-[10px] text-white/20 leading-tight">
                                Capital is deposited here when you save settings.
                                The agent trades exclusively from this address.
                            </p>
                        </>
                    ) : (
                        <div className="flex items-center gap-2 text-[11px] text-white/30">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Generating trading wallet…
                        </div>
                    )}
                </div>

                {/* ── Settings form ── */}
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                        <Label className="text-xs text-white/50">Likely Buy Price (USD)</Label>
                        <Input
                            placeholder="e.g. 0.011500"
                            value={form.likelyBuyPrice}
                            onChange={(e) => handleChange("likelyBuyPrice", e.target.value)}
                            className="bg-white/5 border-white/10 text-white placeholder:text-white/20 focus:border-cyan-500"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs text-white/50">Likely Sell Price (USD)</Label>
                        <Input
                            placeholder="e.g. 0.014000"
                            value={form.likelySellPrice}
                            onChange={(e) => handleChange("likelySellPrice", e.target.value)}
                            className="bg-white/5 border-white/10 text-white placeholder:text-white/20 focus:border-cyan-500"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs text-white/50">Total Trading Capital (CKB)</Label>
                        <Input
                            placeholder="e.g. 10000"
                            value={form.totalCapital}
                            onChange={(e) => handleChange("totalCapital", e.target.value)}
                            className="bg-white/5 border-white/10 text-white placeholder:text-white/20 focus:border-cyan-500"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs text-white/50">Max Amount Per Trade (CKB)</Label>
                        <Input
                            placeholder="e.g. 500"
                            value={form.maxPerTrade}
                            onChange={(e) => handleChange("maxPerTrade", e.target.value)}
                            className="bg-white/5 border-white/10 text-white placeholder:text-white/20 focus:border-cyan-500"
                        />
                    </div>
                </div>

                {/* Step progress while saving */}
                {status === "saving" && (
                    <div className="flex items-center gap-2 text-cyan-400 text-xs bg-cyan-400/10 border border-cyan-400/20 rounded-lg px-3 py-2">
                        <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
                        <span>
                            <span className="text-white/30 mr-1.5">Step {savingStep + 1}/{STEPS.length}</span>
                            {STEPS[savingStep]}
                        </span>
                    </div>
                )}

                {status === "error" && (
                    <div className="flex items-center gap-2 text-red-400 text-xs bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        {errorMsg}
                    </div>
                )}

                {status === "saved" && (
                    <div className="flex items-center gap-2 text-emerald-400 text-xs bg-emerald-400/10 border border-emerald-400/20 rounded-lg px-3 py-2">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        Capital deposited &amp; settings saved. Toggle the switch to start trading.
                    </div>
                )}

                <div className="flex items-center justify-between pt-1">
                    <p className="text-[10px] text-white/25">
                        Wallet: {address ? address.slice(0, 14) + "…" : "—"}
                    </p>
                    <Button
                        onClick={handleSave}
                        disabled={status === "saving" || !tradingWallet}
                        className="bg-cyan-600 hover:bg-cyan-500 text-white text-sm gap-2"
                    >
                        {status === "saving"
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Save className="w-3.5 h-3.5" />
                        }
                        {status === "saving" ? "Processing…" : "Save Settings"}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
