import Groq from "groq-sdk";
import type { AgentContext, AgentDecisionResult, TradeDecision } from "@/agent/types";

const client = new Groq({
    apiKey: process.env.GROQ_API_KEY!,
});

const STOP_LOSS_PCT = 5; // realise the loss if price falls ≥5% below buy price

export async function getAgentDecision(
    ctx: AgentContext
): Promise<AgentDecisionResult> {
    const priceTrend = describeTrend(ctx.recentPrices);
    const distanceToBuy = (
        ((ctx.currentPrice - ctx.likelyBuyPrice) / ctx.likelyBuyPrice) * 100
    ).toFixed(2);
    const distanceToSell = (
        ((ctx.likelySellPrice - ctx.currentPrice) / ctx.currentPrice) * 100
    ).toFixed(2);

    // ── Open position summary ─────────────────────────────────────────────────
    let positionBlock = "  - Open position: none";
    if (ctx.lastBuyPrice !== null && ctx.lastBuyAmount !== null) {
        const unrealisedPct =
            ((ctx.currentPrice - ctx.lastBuyPrice) / ctx.lastBuyPrice) * 100;
        const unrealisedCkb =
            ctx.lastBuyAmount * (ctx.currentPrice - ctx.lastBuyPrice) / ctx.currentPrice;
        const sign = unrealisedPct >= 0 ? "+" : "";
        positionBlock =
            `  - Open position: ${ctx.lastBuyAmount.toFixed(2)} CKB bought @ $${ctx.lastBuyPrice.toFixed(6)}\n` +
            `  - Unrealised P&L: ${sign}${unrealisedPct.toFixed(2)}% (${sign}${unrealisedCkb.toFixed(2)} CKB)\n` +
            `  - Stop-loss threshold: -${STOP_LOSS_PCT}% below buy price` +
            ` ($${(ctx.lastBuyPrice * (1 - STOP_LOSS_PCT / 100)).toFixed(6)})`;
    }

    const prompt = `You are CAIT, an AI trading agent for CKB (Nervos Network) on testnet.

  Current market context:
  - Current CKB price: $${ctx.currentPrice.toFixed(6)} USD
  - Target BUY price:  $${ctx.likelyBuyPrice.toFixed(6)} USD (${distanceToBuy}% away)
  - Target SELL price: $${ctx.likelySellPrice.toFixed(6)} USD (${distanceToSell}% above current)
  - Price trend (last ${ctx.recentPrices.length} readings): ${priceTrend}
  - Recent prices: ${ctx.recentPrices.slice(-5).map((p) => `$${p.toFixed(6)}`).join(", ")}
  - Remaining capital: ${ctx.remainingCapital.toFixed(2)} CKB
  - Max per trade: ${ctx.maxPerTrade.toFixed(2)} CKB
  - Consecutive losses: ${ctx.consecutiveLosses}
  - Last decision: ${ctx.lastDecision ?? "none"}
${positionBlock}

  Trading window rule: Only act if price is within ±25% of the target buy or sell price.
  - Buy window:  $${(ctx.likelyBuyPrice * 0.75).toFixed(6)} – $${(ctx.likelyBuyPrice * 1.25).toFixed(6)}
  - Sell window: $${(ctx.likelySellPrice * 0.75).toFixed(6)} – $${(ctx.likelySellPrice * 1.25).toFixed(6)}

  Respond with a JSON object only — no markdown, no explanation outside the JSON:
  {
    "decision": "buy_now" | "buy_early" | "sell_now" | "sell_early" | "wait" | "hold",
    "reason": "<one concise sentence explaining why, max 100 chars>",
    "confidence": <integer 0-100>
  }

  Rules:
  - "buy_now":   price is at or below buy target, strong signal — only when NO open position
  - "buy_early": price is approaching buy target (within window), momentum favors buying — only when NO open position
  - "sell_now":  price is at or above sell target, strong signal
  - "sell_early": price is approaching sell target (within window), momentum favors selling
  - "wait": price is outside both windows, do nothing
  - "hold": inside a window but conditions are unclear, preserve capital
  - STOP-LOSS RULE: if an open position exists AND current price has fallen ≥${STOP_LOSS_PCT}% below the buy price, you MUST return "sell_now" to cut the loss — do not hold a deeply losing position
  - If remaining capital < 10 CKB, always return "hold"
  - Never open a new buy position while another is already open
  - Be concise and decisive`;

    const completion = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        max_tokens: 256,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? "";

    try {
        const parsed = JSON.parse(raw) as {
            decision: TradeDecision;
            reason: string;
            confidence: number;
        };

        return {
            decision: parsed.decision,
            reason: parsed.reason ?? "No reason provided",
            confidence: Math.min(100, Math.max(0, parsed.confidence ?? 50)),
        };
    } catch {
        // Fallback if the model returns malformed JSON
        return {
            decision: "wait",
            reason: "Could not parse AI response — defaulting to wait",
            confidence: 0,
        };
    }
}

function describeTrend(prices: number[]): string {
    if (prices.length < 2) return "insufficient data";
    const first = prices[0];
    const last = prices[prices.length - 1];
    const change = ((last - first) / first) * 100;
    if (change > 1) return `uptrend (+${change.toFixed(2)}%)`;
    if (change < -1) return `downtrend (${change.toFixed(2)}%)`;
    return `sideways (${change.toFixed(2)}%)`;
}           