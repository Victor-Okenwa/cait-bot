import Groq from "groq-sdk";
import type { AgentContext, AgentDecisionResult, TradeDecision } from "@/agent/types";

// ─── Multi-key client pool ──────────────────────────────────────────────────

type KeySlot = {
    client: Groq;
    rateLimitedUntil: number;
    label: string;
};

const keySlots: KeySlot[] = [];

const KEY_NAMES = [
    "GROQ_API_KEY",
    "GROQ_API_KEY2",
    "GROQ_API_KEY3",
    "GROQ_API_KEY4",
];

for (const name of KEY_NAMES) {
    const apiKey = process.env[name];
    if (apiKey) {
        keySlots.push({
            client: new Groq({ apiKey }),
            rateLimitedUntil: 0,
            label: name,
        });
    }
}

if (keySlots.length === 0) {
    throw new Error("No GROQ_API_KEY* environment variables found.");
}

let roundRobinIndex = 0;

export class AllKeysRateLimitedError extends Error {
    constructor() {
        super("All Groq API keys are rate-limited");
        this.name = "AllKeysRateLimitedError";
    }
}

function pickNextSlot(): KeySlot | null {
    const now = Date.now();
    const len = keySlots.length;
    for (let i = 0; i < len; i++) {
        const idx = (roundRobinIndex + i) % len;
        if (keySlots[idx].rateLimitedUntil <= now) {
            roundRobinIndex = (idx + 1) % len;
            return keySlots[idx];
        }
    }
    return null;
}

function markRateLimited(slot: KeySlot, retryAfterSec: number) {
    const cooldown = Math.max(retryAfterSec, 60) * 1000;
    slot.rateLimitedUntil = Date.now() + cooldown;
    console.warn(
        `⚠️   Key ${slot.label} rate-limited — cooldown ${Math.round(cooldown / 1000)}s`
    );
}

// ─── Decision logic ─────────────────────────────────────────────────────────

const STOP_LOSS_PCT = 5;

export async function getAgentDecision(
    ctx: AgentContext
): Promise<AgentDecisionResult> {
    const prompt = buildPrompt(ctx);

    let lastError: unknown;

    for (let attempt = 0; attempt < keySlots.length; attempt++) {
        const slot = pickNextSlot();
        if (!slot) break;

        try {
            const completion = await slot.client.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                max_tokens: 128,
                response_format: { type: "json_object" },
                messages: [{ role: "user", content: prompt }],
            });

            const raw = completion.choices[0]?.message?.content?.trim() ?? "";
            return parseResponse(raw);
        } catch (err: unknown) {
            lastError = err;
            const status = (err as { status?: number }).status;
            if (status === 429) {
                const retryAfter = parseRetryAfter(err);
                markRateLimited(slot, retryAfter);
                continue;
            }
            throw err;
        }
    }

    if (pickNextSlot() === null) {
        throw new AllKeysRateLimitedError();
    }

    throw lastError;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseRetryAfter(err: unknown): number {
    try {
        const headers = (err as { headers?: Headers }).headers;
        const raw = headers?.get?.("retry-after");
        if (raw) {
            const n = Number(raw);
            if (!isNaN(n)) return n;
        }
    } catch { /* ignore */ }
    return 300;
}

function parseResponse(raw: string): AgentDecisionResult {
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
        return {
            decision: "wait",
            reason: "Could not parse AI response — defaulting to wait",
            confidence: 0,
        };
    }
}

function buildPrompt(ctx: AgentContext): string {
    const priceTrend = describeTrend(ctx.recentPrices);
    const distanceToBuy = (
        ((ctx.currentPrice - ctx.likelyBuyPrice) / ctx.likelyBuyPrice) * 100
    ).toFixed(2);
    const distanceToSell = (
        ((ctx.likelySellPrice - ctx.currentPrice) / ctx.currentPrice) * 100
    ).toFixed(2);

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

    return `You are CAIT, an AI trading agent for CKB (Nervos Network) on testnet.

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
