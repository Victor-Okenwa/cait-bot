"use client";

import { useEffect, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Bot, Save, AlertCircle, CheckCircle2, Loader2,
    Eye, EyeOff, Copy, Check, Wallet2, Info, RefreshCw,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { AgentSettings, TradingAddress } from "@/lib/supabase";

type Status = "idle" | "saving" | "saved" | "error";

const STEP_ADJUST = "Adjusting capital…";
const STEP_DEPOSIT = "Waiting for wallet approval…";
const STEP_SAVE = "Saving settings…";

const MIN_DEPOSIT = 800;   // CKB — minimum non-zero deposit
const MIN_MAX_PER_TRADE = 200;  // CKB
const MAX_TRADE_RATIO = 0.35;  // max_per_trade must be < 35% of total capital

function stringToHex(str: string): string {
    const bytes = new TextEncoder().encode(str);
    return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function AgentControls() {
    const signer = ccc.useSigner();
    const [address, setAddress] = useState<string>("");
    const [status, setStatus] = useState<Status>("idle");
    const [savingMsg, setSavingMsg] = useState("");
    const [errorMsg, setErrorMsg] = useState("");
    const [loading, setLoading] = useState(true);
    const [tradingWallet, setTradingWallet] = useState<TradingAddress | null>(null);
    const [tradingBalance, setTradingBalance] = useState<number | null>(null);
    const [showKey, setShowKey] = useState(false);
    const [copied, setCopied] = useState(false);
    const [currentPrice, setCurrentPrice] = useState<number | null>(null);
    const [priceLoading, setPriceLoading] = useState(false);
    // Simulation capital stored in DB — preserved across saves so P&L is never wiped.
    const [existingTotalCapital, setExistingTotalCapital] = useState<number>(0);

    const [form, setForm] = useState({
        likelyBuyPrice: "",
        likelySellPrice: "",
        totalCapital: "",
        maxPerTrade: "",
    });

    // ── Fetch current CKB price ───────────────────────────────────────────────
    async function fetchPrice() {
        setPriceLoading(true);
        try {
            const res = await fetch("/api/price?type=simple");
            if (res.ok) {
                const data = await res.json();
                const price = data?.["nervos-network"]?.usd as number | undefined;
                if (price) setCurrentPrice(price);
                return price ?? null;
            }
        } catch { /* ignore */ }
        finally { setPriceLoading(false); }
        return null;
    }

    function applyCurrentPrice(price: number) {
        const buy = price.toFixed(6);
        const sell = (price * 1.3).toFixed(6);
        setForm((prev) => ({ ...prev, likelyBuyPrice: buy, likelySellPrice: sell }));
    }

    async function handleRefreshPrice() {
        const price = await fetchPrice();
        if (price) applyCurrentPrice(price);
    }

    // ── Load address, settings, trading wallet, and price ────────────────────
    useEffect(() => {
        if (!signer) { setLoading(false); return; }

        signer.getRecommendedAddress().then(async (addr) => {
            setAddress(addr);

            const [settingsRes, walletRes, priceRes] = await Promise.all([
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
                fetch("/api/price?type=simple"),
            ]);

            // Price
            let livePrice: number | null = null;
            if (priceRes.ok) {
                const priceData = await priceRes.json();
                livePrice = priceData?.["nervos-network"]?.usd ?? null;
                if (livePrice) setCurrentPrice(livePrice);
            }

            // Trading wallet + balance
            if (walletRes.ok) {
                const { trading_address } = await walletRes.json();
                setTradingWallet(trading_address);
                if (trading_address?.address) {
                    const balRes = await fetch(
                        `/api/settings/trading-balance?address=${encodeURIComponent(trading_address.address)}`
                    );
                    if (balRes.ok) {
                        const { balance_ckb } = await balRes.json();
                        setTradingBalance(balance_ckb);
                    }
                }
            }

            // Settings — populate form
            if (settingsRes.data) {
                const d = settingsRes.data;
                setExistingTotalCapital(d.total_capital ?? 0);
                setForm({
                    likelyBuyPrice: String(d.likely_buy_price),
                    likelySellPrice: String(d.likely_sell_price),
                    totalCapital: "0",
                    maxPerTrade: String(d.max_per_trade),
                });
            } else if (livePrice) {
                // First time — pre-fill buy/sell from live price
                applyCurrentPrice(livePrice);
            }

            setLoading(false);
        });
    }, [signer]);

    async function fetchBalance(addr: string) {
        try {
            const res = await fetch(`/api/settings/trading-balance?address=${encodeURIComponent(addr)}`);
            if (res.ok) {
                const { balance_ckb } = await res.json();
                setTradingBalance(balance_ckb);
            }
        } catch { /* ignore */ }
    }

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
        const buy = parseFloat(form.likelyBuyPrice);
        const sell = parseFloat(form.likelySellPrice);
        const deposit = parseFloat(form.totalCapital);
        const max = parseFloat(form.maxPerTrade);

        if (!buy || !sell || isNaN(deposit) || form.totalCapital === "" || !max)
            return "All fields are required.";
        if (buy <= 0 || sell <= 0 || max <= 0)
            return "All values must be greater than 0.";
        if (sell <= buy)
            return "Sell price must be greater than buy price.";
        if (deposit < 0)
            return "Deposit amount cannot be negative.";

        // Deposit: must be 0 or >= 800
        if (deposit > 0 && deposit < MIN_DEPOSIT)
            return `Minimum deposit is ${MIN_DEPOSIT} CKB. Enter 0 to update settings only (requires existing balance > 799 CKB).`;

        // If depositing 0, the trading wallet must already have > 799 CKB
        if (deposit === 0 && (tradingBalance ?? 0) <= 799)
            return `Your trading wallet balance is ${(tradingBalance ?? 0).toFixed(2)} CKB. Deposit at least ${MIN_DEPOSIT} CKB to start.`;

        const totalAfterDeposit = (tradingBalance ?? 0) + deposit;

        // Max per trade: minimum 200 CKB
        if (max < MIN_MAX_PER_TRADE)
            return `Max per trade must be at least ${MIN_MAX_PER_TRADE} CKB.`;

        // Max per trade: must be < 35% of total capital
        const cap = totalAfterDeposit * MAX_TRADE_RATIO;
        if (max >= cap)
            return `Max per trade must be below ${cap.toFixed(0)} CKB (35% of ${totalAfterDeposit.toFixed(0)} CKB total capital).`;

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
        const depositAmount = parseFloat(form.totalCapital) || 0;

        // ── Step 1: Server-side deposit validation ────────────────────────────
        setSavingMsg(STEP_ADJUST);
        let adjustAction: "deposit" | "none";
        if (depositAmount === 0) {
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
                adjustAction = json.action;
            } catch {
                setErrorMsg("Failed to contact server. Check your connection.");
                setStatus("error");
                return;
            }
        }

        // ── Step 2: On-chain deposit ──────────────────────────────────────────
        if (adjustAction === "deposit") {
            setSavingMsg(STEP_DEPOSIT);
            try {
                const toScript = await ccc.Address.fromString(tradingWallet.address, signer.client);
                const amountShannon = ccc.fixedPointFrom(depositAmount.toFixed(8));
                const tx = ccc.Transaction.from({
                    outputs: [{ capacity: amountShannon, lock: toScript.script }],
                    outputsData: [stringToHex(`CAIT DEPOSIT ${depositAmount.toFixed(2)} CKB`)],
                });
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

        // ── Step 3: Upsert settings ───────────────────────────────────────────
        setSavingMsg(STEP_SAVE);
        // total_capital = existing simulation capital + new deposit.
        // We NEVER use tradingBalance here — it reflects the raw on-chain amount
        // which doesn't change with simulation P&L (only real CKB moves).
        const newTotalCapital = existingTotalCapital + depositAmount;
        const payload: Partial<AgentSettings> & Record<string, unknown> = {
            wallet_address:    address,
            likely_buy_price:  parseFloat(form.likelyBuyPrice),
            likely_sell_price: parseFloat(form.likelySellPrice),
            total_capital:     newTotalCapital,
            max_per_trade:     parseFloat(form.maxPerTrade),
            trading_address:   tradingWallet,
            updated_at:        new Date().toISOString(),
            // capital_in_trading, last_buy_price, last_buy_amount,
            // win_count, loss_count, martingale_count, total_pnl_ckb
            // are intentionally omitted — they belong to the agent loop
            // and must never be reset by the settings form.
        };

        const { error: upsertErr } = await supabase
            .from("agent_settings")
            .upsert(payload, { onConflict: "wallet_address" });

        if (upsertErr) {
            setErrorMsg(upsertErr.message);
            setStatus("error");
        } else {
            setStatus("saved");
            setExistingTotalCapital(newTotalCapital);
            if (tradingWallet?.address) fetchBalance(tradingWallet.address);
            setTimeout(() => setStatus("idle"), 3500);
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

    const depositAmt = parseFloat(form.totalCapital) || 0;
    const totalAfterDeposit = (tradingBalance ?? 0) + depositAmt;
    const maxAllowed = totalAfterDeposit * MAX_TRADE_RATIO;

    return (
        <Card className="bg-white/5 border-white/10 text-white">
            <CardHeader className="pb-3">
                <CardTitle className="text-base text-white/80 flex items-center gap-2">
                    <Bot className="w-4 h-4 text-cyan-400" />
                    Automate your trading with AI
                </CardTitle>
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
                                    >
                                        {showKey
                                            ? <EyeOff className="w-3.5 h-3.5" />
                                            : <Eye className="w-3.5 h-3.5" />
                                        }
                                    </button>
                                </div>
                            </div>

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

                    {/* Likely Buy Price */}
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1">
                                <Label className="text-xs text-white/50">Likely Buy Price (USD)</Label>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Info className="w-3 h-3 text-white/25 cursor-help" />
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[220px] size-fit text-center">
                                        The price at which the agent looks to open a buy position.
                                        Pre-filled with the live CKB rate. The agent acts within ±25% of this value.
                                    </TooltipContent>
                                </Tooltip>
                            </div>
                            <button
                                onClick={handleRefreshPrice}
                                disabled={priceLoading}
                                className="flex items-center gap-1 text-[10px] text-cyan-400/60 hover:text-cyan-400 transition-colors disabled:opacity-40"
                                title="Use live rate"
                            >
                                <RefreshCw className={`w-2.5 h-2.5 ${priceLoading ? "animate-spin" : ""}`} />
                                {currentPrice ? `$${currentPrice.toFixed(6)}` : "live rate"}
                            </button>
                        </div>
                        <Input
                            placeholder="e.g. 0.001500"
                            value={form.likelyBuyPrice}
                            onChange={(e) => handleChange("likelyBuyPrice", e.target.value)}
                            className="bg-white/5 border-white/10 text-white placeholder:text-white/20 focus:border-cyan-500"
                        />
                    </div>

                    {/* Likely Sell Price */}
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1">
                                <Label className="text-xs text-white/50">Likely Sell Price (USD)</Label>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Info className="w-3 h-3 text-white/25 cursor-help" />
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[220px] size-fit text-center">
                                        The price at which the agent targets closing a position for profit.
                                        Pre-filled at +30% above the live rate. Must be higher than your buy price.
                                    </TooltipContent>
                                </Tooltip>
                            </div>
                            {currentPrice && (
                                <span className="text-[10px] text-emerald-400/60">
                                    +30% = ${(currentPrice * 1.3).toFixed(6)}
                                </span>
                            )}
                        </div>
                        <Input
                            placeholder="e.g. 0.001950"
                            value={form.likelySellPrice}
                            onChange={(e) => handleChange("likelySellPrice", e.target.value)}
                            className="bg-white/5 border-white/10 text-white placeholder:text-white/20 focus:border-cyan-500"
                        />
                    </div>

                    {/* Deposit Capital */}
                    <div className="space-y-1.5">
                        <div className="flex items-center gap-1">
                            <Label className="text-xs text-white/50">Deposit Capital (CKB)</Label>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Info className="w-3 h-3 text-white/25 cursor-help" />
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-[220px] size-fit text-center flex flex-col *:flex-1 *:text-center">
                                    Amount to add to your trading wallet this session
                                    <span className="mt-1 text-black/70">• Minimum deposit: <strong>800 CKB</strong></span>
                                    <span className="text-black/70">• Enter <strong>0</strong> to update settings only — only allowed if your wallet already holds more than 799 CKB.</span>
                                </TooltipContent>
                            </Tooltip>
                        </div>
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
                                        {tradingBalance.toFixed(2)} + {amt.toFixed(2)} = <span className="font-semibold">{newTotal.toFixed(2)} CKB</span> total
                                    </p>
                                );
                            }
                            return null;
                        })()}
                    </div>

                    {/* Max Per Trade */}
                    <div className="space-y-1.5">
                        <div className="flex items-center gap-1">
                            <Label className="text-xs text-white/50">Max Per Trade (CKB)</Label>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Info className="w-3 h-3 text-white/25 cursor-help" />
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-[240px] flex  flex-col *:flex-1 *:text-center">
                                    Upper bound for a single trade position.
                                    <span className="mt-1 text-black/70">• Minimum: <strong>200 CKB</strong></span>
                                    <span className="text-black/70">• Must be below <strong>35% of total capital</strong> to keep risk in check.</span>
                                    <span className="mt-1 text-black/70">The agent trades at <strong>half this amount</strong> normally, and steps up to the full amount after a loss (Martingale).</span>
                                </TooltipContent>
                            </Tooltip>
                        </div>
                        <Input
                            placeholder="e.g. 400"
                            value={form.maxPerTrade}
                            onChange={(e) => handleChange("maxPerTrade", e.target.value)}
                            className="bg-white/5 border-white/10 text-white placeholder:text-white/20 focus:border-cyan-500"
                        />
                        {totalAfterDeposit > 0 && (
                            <p className="text-[10px] text-white/25 leading-tight">
                                Max allowed: {maxAllowed > 0 ? `${Math.floor(maxAllowed)} CKB` : "—"} (35% of {totalAfterDeposit.toFixed(0)} CKB)
                            </p>
                        )}
                    </div>
                </div>

                {/* Status messages */}
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
                        Settings saved. Use the toggle in Agent Stats to start trading.
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
