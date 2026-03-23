/**
 * CAIT Agent – run in a separate terminal:
 *   bun run agent/index.ts
 *
 * Requires env vars (add to .env.local):
 *   SUPABASE_SERVICE_ROLE_KEY=...   (for DB writes)
 *   ANTHROPIC_API_KEY=...           (for Claude decisions)
 *
 * Each user's trades are signed by their own dedicated trading wallet
 * (stored in agent_settings.trading_address). No shared agent key needed.
 */

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
import { getAddressBalanceCKB } from "@/lib/balance";
import { maybeRefillReserve, sendProfitToUser, collectLossFromUser } from "@/lib/reserve";
import type { AgentSettings, AgentState, TradeDecision, TradingAddress } from "@/agent/types";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const testnetClient = new ccc.ClientPublicTestnet();
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
                capitalInTrading: settings.capital_in_trading ?? 0,
                lastDecision: null,
                lastTradeWasLoss: false,
                consecutiveLosses: 0,
                // ── Restore open position from DB so restarts don't lose context ──
                lastBuyPrice:  settings.last_buy_price  ?? null,
                lastBuyAmount: settings.last_buy_amount ?? null,
                // TX hash is not persisted — will be null after a restart.
                // The confirmation check is skipped when null (safe: if the
                // agent restarted, the buy TX very likely confirmed already).
                lastBuyTxHash: null,
                pendingPnlCkb: settings.pending_pnl_ckb ?? 0,
            },
        });

        if (settings.last_buy_price) {
            const cap = settings.capital_in_trading ?? 0;
            if (cap <= 0) {
                // capital_in_trading is 0 but a position is recorded — the sell guard
                // will block any sell attempt, preventing a zero-amount sell.
                console.warn(
                    `⚠️   Inconsistent DB state: last_buy_price=${settings.last_buy_price.toFixed(6)} ` +
                    `but capital_in_trading=${cap}. Sell will be blocked until DB is corrected.`
                );
            } else {
                console.log(
                    `♻️   Restored open position: ${cap.toFixed(2)} CKB bought @ $${settings.last_buy_price.toFixed(6)}`
                );
            }
        }
    }
    return stateMap.get(key)!;
}

// ─── Main tick ───────────────────────────────────────────────────────────────

async function tick() {
    console.log(`\n⏱  [${new Date().toISOString()}] Agent tick`);

    // Check / refill reserve wallet (no-op if balance is healthy or cooldown active)
    void maybeRefillReserve();

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

    // ── Require a trading wallet ──────────────────────────────────────────────
    const tradingInfo = settings.trading_address as TradingAddress | null;
    if (!tradingInfo?.private_key) {
        console.log("⚠️   No trading wallet configured for this user — skipping.");
        return;
    }

    const userSigner = new ccc.SignerCkbPrivateKey(testnetClient, tradingInfo.private_key);
    const tradingAddr = tradingInfo.address;

    // ── Read actual on-chain balance from trading address ─────────────────────
    const onChainBalance = await getAddressBalanceCKB(tradingAddr);
    console.log(`💼  Trading wallet balance: ${onChainBalance.toFixed(2)} CKB (on-chain)`);

    if (onChainBalance < 61) {
        console.log("⚠️   Trading wallet has insufficient balance (< 61 CKB). Skipping.");
        return;
    }

    // ── Sync in-memory remaining capital ─────────────────────────────────────
    // On the first tick after startup (or if the DB total_capital is 0), seed it
    // from the on-chain balance.  After that, total_capital is owned by the
    // simulation and is only updated when a trade closes — NOT overwritten from
    // the on-chain balance (which never changes due to wins/losses).
    const simulationCapital = settings.total_capital > 0
        ? settings.total_capital
        : onChainBalance;

    agentState.remainingCapital = Math.max(0, simulationCapital - agentState.capitalInTrading);

    // ── Position-aware early exit (before any Claude call) ───────────────────
    // Whether a price window is "relevant" depends entirely on whether a position
    // is currently open.  This is checked HERE — not after Claude speaks — so the
    // agent can never be nudged into a sell it has no position for, or a buy it
    // has no room for.
    const hasPosition =
        agentState.lastBuyPrice !== null && agentState.capitalInTrading > 0;

    const STOP_LOSS_PCT_EARLY = 5;
    const belowStopLoss =
        hasPosition &&
        currentPrice < agentState.lastBuyPrice! * (1 - STOP_LOSS_PCT_EARLY / 100);

    const inBuyWindow =
        currentPrice >= settings.likely_buy_price * 0.75 &&
        currentPrice <= settings.likely_buy_price * 1.25;
    const inSellWindow =
        currentPrice >= settings.likely_sell_price * 0.75 &&
        currentPrice <= settings.likely_sell_price * 1.25;

    if (!hasPosition) {
        // No position held — only buys make sense.  Sell windows are irrelevant.
        if (!inBuyWindow) {
            console.log("📊  No position & price outside buy window — waiting.");
            await saveTrade({ wallet_address: addr, type: "wait", amount: 0, price: currentPrice, reason: "No position — price outside buy window", martingale: false });
            return;
        }
    } else {
        // Position held — only sells make sense (or stop-loss).  Buy windows are irrelevant.
        if (!inSellWindow && !belowStopLoss) {
            console.log("📊  Position open & price outside sell window — holding.");
            await saveTrade({ wallet_address: addr, type: "hold", amount: 0, price: currentPrice, reason: "Position open — price outside sell window", martingale: false });
            return;
        }
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
            lastBuyPrice:  agentState.lastBuyPrice,
            lastBuyAmount: agentState.lastBuyAmount,
        });
    } catch (err) {
        console.error("❌  Claude call failed:", err);
        return;
    }

    console.log(
        `🤖  Decision: ${aiResult.decision} (${aiResult.confidence}%) — ${aiResult.reason}`
    );

    let { decision, reason } = aiResult;
    agentState.lastDecision = decision as TradeDecision;

    // ── Hard stop-loss override ───────────────────────────────────────────────
    // If the AI does not honour the stop-loss rule (e.g. returns "hold" while
    // deeply in the red), enforce it here regardless of what Claude returned.
    if (belowStopLoss && decision !== "sell_now" && decision !== "sell_early") {
        const dropPct = (
            ((agentState.lastBuyPrice! - currentPrice) / agentState.lastBuyPrice!) * 100
        ).toFixed(2);
        console.log(
            `🛑  Stop-loss triggered: price dropped ${dropPct}% below buy price — forcing sell.`
        );
        decision = "sell_now";
        reason   = `Stop-loss: price fell ${dropPct}% below entry $${agentState.lastBuyPrice!.toFixed(6)}`;
    }

    // Map decision to trade type
    let isBuy  = decision === "buy_now"  || decision === "buy_early";
    let isSell = decision === "sell_now" || decision === "sell_early";
    const isPassive = decision === "wait"  || decision === "hold";

    // ── Position guards ───────────────────────────────────────────────────────
    // Sell without an open position: nothing to sell — demote to hold.
    // Both lastBuyPrice and capitalInTrading must be set; either being absent
    // means no real buy was ever committed (guards against stale DB state).
    if (isSell && (agentState.lastBuyPrice === null || agentState.capitalInTrading <= 0)) {
        console.log("⚠️   Sell decision ignored — no open position to close.");
        isSell = false;
        await saveTrade({ wallet_address: addr, type: "hold", amount: 0, price: currentPrice, reason: "No open position — sell skipped", martingale: false });
        return;
    }
    // Buy while already holding a position: would double-expose — demote to hold.
    if (isBuy && agentState.lastBuyPrice !== null) {
        console.log("⚠️   Buy decision ignored — position already open.");
        isBuy = false;
        await saveTrade({ wallet_address: addr, type: "hold", amount: 0, price: currentPrice, reason: "Position already open — buy skipped", martingale: false });
        return;
    }

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
    // For buys: use Martingale sizing (half or full maxPerTrade).
    // For sells: close the ENTIRE accumulated position — strictly capitalInTrading,
    //            no fallbacks.  The position guard above already ensures this is > 0.
    const { amount: buyAmount, isMartingale } = calculateTradeSize(
        settings.max_per_trade,
        agentState.remainingCapital,
        martingale
    );

    const amount = isSell ? agentState.capitalInTrading : buyAmount;

    if (amount < 61) {
        console.log("⚠️    Trade amount too small (< 61 CKB minimum). Skipping.");
        return;
    }

    if (isSell) {
        console.log(`📦  Closing full position: ${amount.toFixed(2)} CKB (capital_in_trading)`);
    }

    // ── Guard: for sells, verify the buy TX is confirmed on-chain ─────────────
    // The CKB node resolves inputs against the confirmed UTXO set only.
    // If the buy TX is still in the mempool, its change output (used as input
    // for the sell TX) is "Unknown" to the node → TransactionFailedToResolve.
    if (isSell && agentState.lastBuyTxHash) {
        let txStatus: string | undefined;
        try {
            const txRecord = await testnetClient.getTransaction(agentState.lastBuyTxHash);
            txStatus = txRecord?.status;
        } catch {
            txStatus = undefined;
        }

        if (txStatus !== "committed") {
            if (!txStatus || txStatus === "rejected" || txStatus === "unknown") {
                // Buy TX was dropped — clear the open position so the agent
                // doesn't keep trying to sell something that never happened.
                console.log(
                    `⚠️   Buy TX ${agentState.lastBuyTxHash.slice(0, 10)}... dropped from mempool. Clearing open position.`
                );
                agentState.lastBuyPrice  = null;
                agentState.lastBuyAmount = null;
                agentState.lastBuyTxHash = null;
                await db.from("agent_settings").update({
                    last_buy_price:     null,
                    last_buy_amount:    null,
                    capital_in_trading: 0,
                }).eq("wallet_address", addr);
            } else {
                // Still pending — wait for the next tick.
                console.log(
                    `⏳   Buy TX ${agentState.lastBuyTxHash.slice(0, 10)}... still ${txStatus} — skipping sell until confirmed.`
                );
            }
            return;
        }

        // TX confirmed — no longer need to track the hash.
        agentState.lastBuyTxHash = null;
    }

    // Execute on-chain memo transfer (simulation — self-transfer from trading wallet)
    const memo = `CAIT ${decision.toUpperCase()} ${amount.toFixed(2)} CKB @ $${currentPrice.toFixed(6)}`;
    let txHash: string | undefined;
    let explorerLink: string | undefined;

    try {
        const result = await sendCKBWithMemo(userSigner, tradingAddr, amount, memo);
        txHash = result.txHash;
        explorerLink = result.explorerLink;
        console.log(`✅  TX sent: ${txHash}`);
    } catch (err) {
        console.error("❌  Transaction failed:", err);
        if (isBuy) {
            // A failed buy TX means no position was opened — do not update state.
            // If we set lastBuyPrice here and persist it to DB, the agent will think
            // a position is open and attempt sells on the next tick (even though
            // nothing was bought). Skip the tick entirely.
            console.log("⚠️   Buy TX failed — skipping state update to prevent phantom position.");
            return;
        }
        // For sells: the position is considered closed regardless of TX outcome
        // (the simulation tracks intent, not on-chain confirmation for sells).
    }

    // ── P&L calculation (only on sell) ───────────────────────────────────────
    // Formula: the position was opened with `lastBuyAmount` CKB at `lastBuyPrice`.
    // The USD value of that position has changed by lastBuyAmount × ΔPrice.
    // We convert that back to CKB at the current price to get the CKB-equivalent
    // gain or loss.  pnl_ckb is positive on a win, negative on a loss.
    let pnl_usd: number | null = null;
    let pnl_ckb: number | null = null;

    if (isSell && agentState.lastBuyPrice !== null) {
        // Use the full closed position size (= capital_in_trading) for accurate P&L.
        pnl_usd = amount * (currentPrice - agentState.lastBuyPrice);
        pnl_ckb = pnl_usd / currentPrice;
        const sign = pnl_usd >= 0 ? "+" : "";
        console.log(`📈  P&L: ${sign}${pnl_usd.toFixed(4)} USD  (${sign}${pnl_ckb.toFixed(2)} CKB)`);
    }

    // ── Martingale: was this a loss? ──────────────────────────────────────────
    const wasLoss = isSell && agentState.lastBuyPrice !== null
        ? currentPrice < agentState.lastBuyPrice
        : false;

    // ── Update in-memory state ────────────────────────────────────────────────
    if (isBuy) {
        agentState.remainingCapital -= amount;
        agentState.capitalInTrading += amount;
        agentState.lastBuyPrice  = currentPrice;
        agentState.lastBuyAmount = amount;
        agentState.lastBuyTxHash = txHash ?? null;  // track for confirmation check on next sell
    } else if (isSell) {
        // Return the original stake AND apply the P&L.
        // pnl_ckb is positive on a win (capital grows) and negative on a loss
        // (capital shrinks) — this is the core of the simulation accounting.
        agentState.remainingCapital += amount + (pnl_ckb ?? 0);
        agentState.capitalInTrading  = 0;
        agentState.lastBuyPrice  = null;
        agentState.lastBuyAmount = null;
        agentState.lastBuyTxHash = null;
    }

    const updatedMartingale = updateMartingaleState(martingale, wasLoss);
    agentState.lastTradeWasLoss  = wasLoss;
    agentState.consecutiveLosses = updatedMartingale.consecutiveLosses;
    stateMap.set(addr, { martingale: updatedMartingale, agentState });

    // ── Real on-chain P&L settlement ─────────────────────────────────────────
    // Accumulate P&L until it crosses ±61 CKB (CKB minimum cell size), then
    // settle with a real on-chain transfer between reserve and user wallets.
    let settleTxHash: string | null = null;
    let settlementAmount = 0;

    if (isSell && pnl_ckb !== null) {
        agentState.pendingPnlCkb += pnl_ckb;
        const pending = agentState.pendingPnlCkb;

        if (pending >= 61) {
            // Profit: reserve sends CKB to user's trading wallet
            const result = await sendProfitToUser(tradingAddr, pending, currentPrice);
            if (result) {
                settleTxHash    = result.txHash;
                settlementAmount = result.amountCKB;
                agentState.pendingPnlCkb = 0;
                console.log(`💰  Settled +${settlementAmount.toFixed(2)} CKB profit on-chain.`);
            } else {
                console.log(`⏳  Profit pending (${pending.toFixed(2)} CKB) — reserve insufficient, will retry.`);
            }
        } else if (pending <= -61) {
            // Loss: user's trading wallet sends CKB to reserve
            const result = await collectLossFromUser(userSigner, tradingAddr, Math.abs(pending), currentPrice);
            if (result) {
                settleTxHash    = result.txHash;
                settlementAmount = result.amountCKB;
                agentState.pendingPnlCkb = 0;
                console.log(`💸  Collected -${settlementAmount.toFixed(2)} CKB loss on-chain.`);
            } else {
                console.log(`⏳  Loss pending (${pending.toFixed(2)} CKB) — wallet constrained, will retry.`);
            }
        } else {
            console.log(`⏳  P&L pending (${pending.toFixed(2)} CKB) — below 61 CKB threshold, accumulating.`);
        }
    }

    // ── Persist trade ─────────────────────────────────────────────────────────
    const tradeId = await saveTrade({
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
        profit_tx_hash: settleTxHash,
    });

    // If settlement happened after trade save, ensure profit_tx_hash is set
    // (already passed above; this path handles future async settle flows)
    void tradeId;

    // ── Persist stats + position to DB ────────────────────────────────────────
    // total_capital is the simulation capital — set on a sell to reflect P&L.
    // On a buy it stays unchanged (capital is just redistributed: remaining ↓,
    // capital_in_trading ↑).  We never overwrite it from on-chain balance.
    const dbUpdate: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
    };

    if (isBuy) {
        // Use in-memory capitalInTrading — avoids stale DB read causing off-by-one.
        dbUpdate.capital_in_trading = agentState.capitalInTrading;
        dbUpdate.last_buy_price     = currentPrice;
        dbUpdate.last_buy_amount    = amount;
    }

    if (isSell) {
        // Simulation capital = remaining + what's still in trade (0 after close)
        dbUpdate.total_capital      = agentState.remainingCapital;
        dbUpdate.capital_in_trading = 0;
        dbUpdate.last_buy_price     = null;
        dbUpdate.last_buy_amount    = null;
        dbUpdate.pending_pnl_ckb    = agentState.pendingPnlCkb;
        if (wasLoss) {
            dbUpdate.loss_count = (settings.loss_count ?? 0) + 1;
        } else {
            dbUpdate.win_count = (settings.win_count ?? 0) + 1;
        }
        if (pnl_ckb !== null) {
            dbUpdate.total_pnl_ckb = (settings.total_pnl_ckb ?? 0) + pnl_ckb;
        }
    }

    if (isMartingale) {
        dbUpdate.martingale_count = (settings.martingale_count ?? 0) + 1;
    }

    const { error: dbErr } = await db
        .from("agent_settings")
        .update(dbUpdate)
        .eq("wallet_address", addr);

    if (dbErr) {
        console.error("❌  DB update failed (capital_in_trading may be stale):", dbErr.message);
    }
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
    profit_tx_hash?: string | null;
}): Promise<string | null> {
    const { data, error } = await db.from("trades").insert({
        ...trade,
        timestamp: new Date().toISOString(),
    }).select("id").single();
    if (error) { console.error("❌  Failed to save trade:", error.message); return null; }
    return data?.id ?? null;
}

// ─── Exports ──────────────────────────────────────────────────────────────────
// `tick` is exported so it can be called from an API route (Vercel Cron) or
// directly by the standalone runner (agent/run.ts → Render / local).

export { tick };
