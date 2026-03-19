
export type TradeDecision = "buy_now" | "buy_early" | "sell_now" | "sell_early" | "wait" | "hold";

export type AgentDecisionResult = {
    decision: TradeDecision;
    reason: string;
    confidence: number; // 0–100
};

export type AgentContext = {
    currentPrice: number;
    likelyBuyPrice: number;
    likelySellPrice: number;
    totalCapital: number;
    remainingCapital: number;
    maxPerTrade: number;
    lastDecision: TradeDecision | null;
    consecutiveLosses: number;
    recentPrices: number[]; // last N prices for trend context
};

export type TradeRecord = {
    wallet_address: string;
    type: "buy" | "sell" | "hold" | "wait";
    amount: number;
    price: number;
    reason: string;
    martingale: boolean;
    tx_hash?: string;
    explorer_link?: string;
};

export type AgentSettings = {
    id?: string;
    wallet_address: string;
    likely_buy_price: number;
    likely_sell_price: number;
    total_capital: number;
    max_per_trade: number;
    is_running: boolean;
    updated_at?: string;
};

export type AgentState = {
    walletAddress: string;
    remainingCapital: number;
    lastDecision: TradeDecision | null;
    lastTradeWasLoss: boolean;
    consecutiveLosses: number;
    lastBuyPrice: number | null;
};