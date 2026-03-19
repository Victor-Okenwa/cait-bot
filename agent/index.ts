/**                                                                                                                            
   * CAIT Agent – run in a separate terminal:                                                                                    
   *   bun run agent/index.ts                                                                                                    
   *                                                                                                                             
   * Requires additional env vars (add to .env.local):
   *   AGENT_PRIVATE_KEY=0x...   (testnet wallet private key)                                                                    
   *   AGENT_WALLET_ADDRESS=ckt1... (corresponding testnet address)                                                              
   */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { ccc } from "@ckb-ccc/core";
import { createServiceClient } from "@/lib/supabase";
import { fetchAndRecordPrice, getPriceHistory } from "@/lib/price";
import { getAgentDecision } from "@/lib/agent-decision";
import {
    calculateTradeSize,
    initialMartingaleState,
    updateMartingaleState,
    type MartingaleState,
} from "@/lib/martingale";
import { sendCKBWithMemo } from "@/lib/ccc";
import type { AgentSettings, AgentState, TradeDecision } from "@/agent/types";

const INTERVAL_MS = 60_000;
const EXPLORER_BASE = "https://testnet.explorer.nervos.org/transaction";

// ─── Bootstrap ───────────────────────────────────────────────────────────────                                               

const privateKey = process.env.AGENT_PRIVATE_KEY;
const walletAddress = process.env.AGENT_WALLET_ADDRESS;

if (!privateKey || !walletAddress) {
    console.error(
        "❌  AGENT_PRIVATE_KEY and AGENT_WALLET_ADDRESS must be set in .env.local"
    );
    process.exit(1);
}

const testnetClient = new ccc.ClientPublicTestnet();
const signer = new ccc.SignerCkbPrivateKey(testnetClient, privateKey);
const db = createServiceClient();

// ─── Per-wallet runtime state (in memory) ────────────────────────────────────                                               

const stateMap = new Map<
    string,
    { martingale: MartingaleState; agentState: AgentState }
>();

function getOrInitState(settings: AgentSettings): {
    martingale: MartingaleState;
    agentState: AgentState;
} {
    const key = settings.wallet_address;
    if (!stateMap.has(key)) {
        stateMap.set(key, {
            martingale: initialMartingaleState(),
            agentState: {
                walletAddress: key,
                remainingCapital: settings.total_capital,
                lastDecision: null,
                lastTradeWasLoss: false,
                consecutiveLosses: 0,
                // ── Restore open position from DB so restarts don't lose context ──
                lastBuyPrice:  settings.last_buy_price  ?? null,
                lastBuyAmount: settings.last_buy_amount ?? null,
            },
        });

        if (settings.last_buy_price) {
            console.log(
                `♻️   Restored open position: bought ${settings.last_buy_amount?.toFixed(2)} CKB @ $${settings.last_buy_price.toFixed(6)}`
            );
        }
    }
    return stateMap.get(key)!;
}

// ─── Main tick ───────────────────────────────────────────────────────────────                                               

async function tick() {
    console.log(`\n⏱  [${new Date().toISOString()}] Agent tick`);

    // Fetch latest price
    let pricePoint;
    try {
        pricePoint = await fetchAndRecordPrice();
        console.log(`💰  CKB price: $${pricePoint.price.toFixed(6)}`);
    } catch (err) {
        console.error("❌  Price fetch failed:", err);
        return;
    }

    // Load all running settings rows                                                                                            
    const { data: settingsRows, error } = await db
        .from("agent_settings")
        .select("*")
        .eq("is_running", true);

    if (error) {
        console.error("❌  Supabase read error:", error.message);
        return;
    }

    if (!settingsRows || settingsRows.length === 0) {
        console.log("⏸   No active agents.");
        return;
    }

    for (const settings of settingsRows as AgentSettings[]) {
        await processWallet(settings, pricePoint.price);
    }
}

async function processWallet(settings: AgentSettings, currentPrice: number) {
    const { martingale, agentState } = getOrInitState(settings);
    const addr = settings.wallet_address;
    console.log(`\n👛  Processing wallet: ${addr.slice(0, 12)}...`);

    // Check ±25% windows                                                                                                        
    const inBuyWindow =
        currentPrice >= settings.likely_buy_price * 0.75 &&
        currentPrice <= settings.likely_buy_price * 1.25;
    const inSellWindow =
        currentPrice >= settings.likely_sell_price * 0.75 &&
        currentPrice <= settings.likely_sell_price * 1.25;

    if (!inBuyWindow && !inSellWindow) {
        console.log("📊  Price outside both windows — skipping AI call.");
        await saveTrade({
            wallet_address: addr,
            type: "wait",
            amount: 0,
            price: currentPrice,
            reason: "Price outside ±25% buy/sell windows",
            martingale: false,
        });
        return;
    }

    // Ask Claude for decision                                                                                                   
    const recentPrices = getPriceHistory().map((p) => p.price);
    let aiResult;
    try {
        aiResult = await getAgentDecision({
            currentPrice,
            likelyBuyPrice: settings.likely_buy_price,
            likelySellPrice: settings.likely_sell_price,
            totalCapital: settings.total_capital,
            remainingCapital: agentState.remainingCapital,
            maxPerTrade: settings.max_per_trade,
            lastDecision: agentState.lastDecision,
            consecutiveLosses: agentState.consecutiveLosses,
            recentPrices,
        });
    } catch (err) {
        console.error("❌  Claude call failed:", err);
        return;
    }

    console.log(
        `🤖  Decision: ${aiResult.decision} (${aiResult.confidence}%) — ${aiResult.reason}`
    );

    const { decision, reason } = aiResult;
    agentState.lastDecision = decision as TradeDecision;

    // Map decision to trade type                                                                                                
    const isBuy = decision === "buy_now" || decision === "buy_early";
    const isSell = decision === "sell_now" || decision === "sell_early";
    const isPassive = decision === "wait" || decision === "hold";

    if (isPassive) {
        await saveTrade({
            wallet_address: addr,
            type: decision === "wait" ? "wait" : "hold",
            amount: 0,
            price: currentPrice,
            reason,
            martingale: false,
        });
        return;
    }

    // Calculate trade size                                                                                                      
    const { amount, isMartingale } = calculateTradeSize(
        settings.max_per_trade,
        agentState.remainingCapital,
        martingale
    );

    if (amount < 61) {
        console.log("⚠️    Trade amount too small (< 61 CKB minimum). Skipping.");
        return;
    }

    // Execute on-chain memo transfer (simulation)                                                                               
    const memo = `CAIT ${decision.toUpperCase()} ${amount.toFixed(2)} CKB @ $${currentPrice.toFixed(6)}`;
    let txHash: string | undefined;
    let explorerLink: string | undefined;

    try {
        const result = await sendCKBWithMemo(signer, walletAddress!, amount, memo);
        txHash = result.txHash;
        explorerLink = result.explorerLink;
        console.log(`✅  TX sent: ${txHash}`);
    } catch (err) {
        console.error("❌  Transaction failed:", err);
        // Still log the trade attempt                                                                                             
    }

    // ── P&L calculation (only on sell) ───────────────────────────────────────
    let pnl_usd: number | null = null;
    let pnl_ckb: number | null = null;
    let profit_tx_hash: string | undefined;

    if (isSell && agentState.lastBuyPrice !== null && agentState.lastBuyAmount !== null) {
        pnl_usd = agentState.lastBuyAmount * (currentPrice - agentState.lastBuyPrice);
        pnl_ckb = pnl_usd / currentPrice;
        const sign = pnl_usd >= 0 ? "+" : "";
        console.log(`📈  P&L: ${sign}${pnl_usd.toFixed(4)} USD  (${sign}${pnl_ckb.toFixed(2)} CKB)`);

        if (pnl_ckb > 61) {
            const profitMemo = `CAIT PROFIT ${pnl_ckb.toFixed(2)} CKB | P&L $${pnl_usd.toFixed(4)}`;
            try {
                const profitResult = await sendCKBWithMemo(signer, addr, pnl_ckb, profitMemo);
                profit_tx_hash = profitResult.txHash;
                console.log(`💸  Profit sent to owner: ${profitResult.txHash}`);
            } catch (err) {
                console.error("❌  Profit payout TX failed:", err);
            }
        } else if (pnl_ckb > 0) {
            console.log(`ℹ️   Profit ${pnl_ckb.toFixed(2)} CKB below 61 CKB minimum — skipping payout.`);
        } else {
            console.log(`📉  Loss trade — no profit payout.`);
        }
    }

    // ── Martingale: was this a loss? ──────────────────────────────────────────
    const wasLoss = isSell && agentState.lastBuyPrice !== null
        ? currentPrice < agentState.lastBuyPrice
        : false;

    // ── Update in-memory state ────────────────────────────────────────────────
    if (isBuy) {
        agentState.remainingCapital -= amount;
        agentState.lastBuyPrice  = currentPrice;
        agentState.lastBuyAmount = amount;
    } else if (isSell) {
        agentState.remainingCapital += amount;
        agentState.lastBuyPrice  = null;
        agentState.lastBuyAmount = null;
    }

    const updatedMartingale = updateMartingaleState(martingale, wasLoss);
    agentState.lastTradeWasLoss  = wasLoss;
    agentState.consecutiveLosses = updatedMartingale.consecutiveLosses;
    stateMap.set(addr, { martingale: updatedMartingale, agentState });

    // ── Persist trade ─────────────────────────────────────────────────────────
    await saveTrade({
        wallet_address: addr,
        type: isBuy ? "buy" : "sell",
        amount,
        price: currentPrice,
        reason,
        martingale: isMartingale,
        tx_hash: txHash,
        explorer_link: explorerLink,
        pnl_ckb,
        pnl_usd,
        profit_tx_hash,
    });

    // ── Persist stats + position to DB ───────────────────────────────────────
    const dbUpdate: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
        total_capital: agentState.remainingCapital,
    };

    if (isBuy) {
        dbUpdate.capital_in_trading = (settings.capital_in_trading ?? 0) + amount;
        dbUpdate.last_buy_price     = currentPrice;
        dbUpdate.last_buy_amount    = amount;
    }

    if (isSell) {
        dbUpdate.capital_in_trading = 0;
        dbUpdate.last_buy_price     = null;
        dbUpdate.last_buy_amount    = null;
        // Win/loss counters
        if (wasLoss) {
            dbUpdate.loss_count = (settings.loss_count ?? 0) + 1;
        } else {
            dbUpdate.win_count = (settings.win_count ?? 0) + 1;
        }
        // Running P&L total
        if (pnl_ckb !== null) {
            dbUpdate.total_pnl_ckb = (settings.total_pnl_ckb ?? 0) + pnl_ckb;
        }
    }

    if (isMartingale) {
        dbUpdate.martingale_count = (settings.martingale_count ?? 0) + 1;
    }

    await db
        .from("agent_settings")
        .update(dbUpdate)
        .eq("wallet_address", addr);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function saveTrade(trade: {
    wallet_address: string;
    type: "buy" | "sell" | "hold" | "wait";
    amount: number;
    price: number;
    reason: string;
    martingale: boolean;
    tx_hash?: string;
    explorer_link?: string;
    pnl_ckb?: number | null;
    pnl_usd?: number | null;
    profit_tx_hash?: string;
}) {
    const { error } = await db.from("trades").insert({
        ...trade,
        timestamp: new Date().toISOString(),
    });
    if (error) console.error("❌  Failed to save trade:", error.message);
}

// ─── Start loop ───────────────────────────────────────────────────────────────                                              

console.log("🚀  CAIT Agent starting on CKB Testnet...");
console.log(`👛  Wallet: ${walletAddress}`);
console.log(`⏱  Interval: ${INTERVAL_MS / 1000}s\n`);

tick(); // run immediately on start                                                                                            
setInterval(tick, INTERVAL_MS);     