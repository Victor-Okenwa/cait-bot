import type { AgentContext, AgentDecisionResult } from "@/agent/types";

const STOP_LOSS_PCT = 5;
const EARLY_THRESHOLD_PCT = 5;

/**
 * Deterministic rule engine — handles clear-cut trading decisions without
 * calling the AI.  Returns `null` when the situation is ambiguous and the
 * AI should be consulted.
 */
export function getRuleBasedDecision(
    ctx: AgentContext
): AgentDecisionResult | null {
    const hasPosition = ctx.lastBuyPrice !== null && ctx.lastBuyAmount !== null;
    const trend = describeTrend(ctx.recentPrices);

    // 1. Low capital, no position → hold
    if (ctx.remainingCapital < 10 && !hasPosition) {
        return {
            decision: "hold",
            reason: "Rule: remaining capital below 10 CKB",
            confidence: 100,
        };
    }

    // 2. Stop-loss: position open + price fell >= STOP_LOSS_PCT below buy
    if (hasPosition) {
        const dropPct =
            ((ctx.lastBuyPrice! - ctx.currentPrice) / ctx.lastBuyPrice!) * 100;
        if (dropPct >= STOP_LOSS_PCT) {
            return {
                decision: "sell_now",
                reason: `Rule: stop-loss triggered (${dropPct.toFixed(1)}% below entry)`,
                confidence: 100,
            };
        }
    }

    // 3. No position + price at or below buy target → buy_now
    if (!hasPosition && ctx.currentPrice <= ctx.likelyBuyPrice) {
        return {
            decision: "buy_now",
            reason: "Rule: price at/below buy target",
            confidence: 90,
        };
    }

    // 4. Position open + price at or above sell target → sell_now
    if (hasPosition && ctx.currentPrice >= ctx.likelySellPrice) {
        return {
            decision: "sell_now",
            reason: "Rule: price at/above sell target",
            confidence: 90,
        };
    }

    // 5. No position + price within EARLY_THRESHOLD_PCT of buy target + downtrend
    if (!hasPosition) {
        const distPct =
            ((ctx.currentPrice - ctx.likelyBuyPrice) / ctx.likelyBuyPrice) * 100;
        if (Math.abs(distPct) <= EARLY_THRESHOLD_PCT && trend === "down") {
            return {
                decision: "buy_early",
                reason: `Rule: ${distPct.toFixed(1)}% from buy target, downtrend`,
                confidence: 75,
            };
        }
    }

    // 6. Position open + price within EARLY_THRESHOLD_PCT of sell target + uptrend
    if (hasPosition) {
        const distPct =
            ((ctx.likelySellPrice - ctx.currentPrice) / ctx.currentPrice) * 100;
        if (distPct <= EARLY_THRESHOLD_PCT && trend === "up") {
            return {
                decision: "sell_early",
                reason: `Rule: ${distPct.toFixed(1)}% from sell target, uptrend`,
                confidence: 75,
            };
        }
    }

    // 7. Ambiguous — let the AI decide
    return null;
}

type Trend = "up" | "down" | "sideways";

function describeTrend(prices: number[]): Trend {
    if (prices.length < 2) return "sideways";
    const first = prices[0];
    const last = prices[prices.length - 1];
    const change = ((last - first) / first) * 100;
    if (change > 1) return "up";
    if (change < -1) return "down";
    return "sideways";
}
