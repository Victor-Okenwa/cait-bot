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

// Step labels — step 1 (deposit) is conditionally skipped
const STEP_ADJUST  = "Adjusting capital…";
const STEP_DEPOSIT = "Waiting for wallet approval…";
const STEP_SAVE    = "Saving settings…";

function stringToHex(str: string): string {
    const bytes = new TextEncoder().encode(str);
    return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function AgentControls() {
    const signer = ccc.useSigner();
    const [address, setAddress]             = useState<string>("");
    const [isRunning, setIsRunning]         = useState(false);
    const [status, setStatus]               = useState<Status>("idle");
    const [savingMsg, setSavingMsg]         = useState("");
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

            // Fetch on-chain balance inline so we can pre-fill the capital field
            // with the actual current balance (not the stale DB value).
            let onChainBalance: number | null = null;
            if (walletRes.ok) {
                const { trading_address } = await walletRes.json();
                setTradingWallet(trading_address);
                if (trading_address?.address) {
                    const balRes = await fetch(
                        `/api/settings/trading-balance?address=${encodeURIComponent(trading_address.address)}`
                    );
                    if (balRes.ok) {
                        const { balance_ckb } = await balRes.json();
                        onChainBalance = balance_ckb;
                        setTradingBalance(balance_ckb);
                    }
                }
            }

            if (settingsRes.data) {
                const d = settingsRes.data;
                setForm({
                    likelyBuyPrice: String(d.likely_buy_price),
                    likelySellPrice: String(d.likely_sell_price),
                    // Default to "0": this field is how much to ADD, not the total.
                    // The current balance is shown in the trading wallet panel above.
                    totalCapital: "0",
                    maxPerTrade: String(d.max_per_trade),
                });
                setIsRunning(d.is_running);
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
        const deposit = parseFloat(form.totalCapital);   // amount to ADD this session
        const max     = parseFloat(form.maxPerTrade);

        if (!buy || !sell || isNaN(deposit) || form.totalCapital === "" || !max)
            return "All fields are required.";
        if (buy <= 0 || sell <= 0 || max <= 0)
            return "All values must be greater than 0.";
        if (sell <= buy) return "Sell price must be greater than buy price.";
        if (deposit < 0) return "Deposit amount cannot be negative.";
        if (deposit > 0 && deposit < 60)
            return "Minimum deposit is 60 CKB. Enter 0 to update settings without depositing.";
        // Validate max-per-trade against total capital after this deposit
        const totalAfterDeposit = (tradingBalance ?? 0) + deposit;
        if (totalAfterDeposit > 0 && max > totalAfterDeposit)
            return "Max per trade cannot exceed total capital.";
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
        const depositAmount = parseFloat(form.totalCapital) || 0; // amount to ADD

        // ── Step 1: Validate deposit server-side (balance check) ─────────────────
        setSavingMsg(STEP_ADJUST);
        let adjustAction: "deposit" | "none";
        if (depositAmount === 0) {
            // No deposit requested — skip the server round-trip entirely
            adjustAction = "none";
        } else {
            try {
                const res = await fetch("/api/settings/recapitalize", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ wallet_address: address, new_capital: depositAmount }),
                });
                const json = await res.json();
                if (!res.ok) {
                    setErrorMsg(json.error ?? "Capital adjustment failed.");
                    setStatus("error");
                    return;
                }
                adjustAction = json.action; // "deposit" | "none"
            } catch {
                setErrorMsg("Failed to contact server. Check your connection.");
                setStatus("error");
                return;
            }
        }

        // ── Step 2: Deposit the requested amount if the server approved it ────────
        if (adjustAction === "deposit") {
            setSavingMsg(STEP_DEPOSIT);
            try {
                const toScript = await ccc.Address.fromString(
                    tradingWallet.address,
                    signer.client
                );
                const amountShannon = ccc.fixedPointFrom(depositAmount.toFixed(8));

                const tx = ccc.Transaction.from({
                    outputs: [{ capacity: amountShannon, lock: toScript.script }],
                    outputsData: [stringToHex(`CAIT DEPOSIT ${depositAmount.toFixed(2)} CKB`)],
                });

                // Include cells that carry data (e.g. "CAIT REFUND" memos that
                // landed in the user's wallet), so they can fund this deposit.
                const cellFilter = { outputDataLenRange: [0, 0xffffffff] as [number, number] };
                await tx.completeInputsByCapacity(signer, undefined, cellFilter);
                await tx.completeFeeBy(signer, 1000, cellFilter);
                await signer.sendTransaction(tx);
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                setErrorMsg(`Deposit transaction failed: ${msg}`);
                setStatus("error");
                return;
            }
        }

        // ── Step 3: Upsert settings ───────────────────────────────────────────────
        setSavingMsg(STEP_SAVE);
        // total_capital = current on-chain balance + newly deposited amount
        const newTotalCapital = (tradingBalance ?? 0) + depositAmount;
        const payload: AgentSettings & Record<string, unknown> = {
            wallet_address: address,
            likely_buy_price: parseFloat(form.likelyBuyPrice),
            likely_sell_price: parseFloat(form.likelySellPrice),
            total_capital: newTotalCapital,
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
            // Refresh balance display
            if (tradingWallet?.address) fetchBalance(tradingWallet.address);
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
                        <Label className="text-xs text-white/50">Deposit Capital (CKB)</Label>
                        <Input
                            placeholder="0"
                            value={form.totalCapital}
                            onChange={(e) => handleChange("totalCapital", e.target.value)}
                            className="bg-white/5 border-white/10 text-white placeholder:text-white/20 focus:border-cyan-500"
                        />
                        {(() => {
                            const amt = parseFloat(form.totalCapital);
                            if (amt > 0 && tradingBalance !== null) {
                                const newTotal = tradingBalance + amt;
                                return (
                                    <p className="text-[10px] text-cyan-300/70 leading-tight">
                                        {tradingBalance.toFixed(2)} + {amt.toFixed(2)} = <span className="font-semibold">{newTotal.toFixed(2)} CKB</span> total — your wallet will be debited {amt.toFixed(2)} CKB.
                                    </p>
                                );
                            }
                            return (
                                <p className="text-[10px] text-white/25 leading-tight">
                                    Amount to add to your trading wallet. Enter 0 to update settings only. Min 60 CKB per deposit.
                                </p>
                            );
                        })()}
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
                        {savingMsg}
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
                        Settings saved. Toggle the switch to start trading.
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
