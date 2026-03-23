
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
    // Open position — null when no position is held
    lastBuyPrice: number | null;
    lastBuyAmount: number | null;
};

export type TradingAddress = {
    address: string;
    private_key: string;
    lock_arg: string;
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
    // Per-user dedicated trading wallet
    trading_address?: TradingAddress | null;
    // Position tracking (persisted so agent restarts don't lose context)
    capital_in_trading: number;
    last_buy_price: number | null;
    last_buy_amount: number | null;
    // Stats counters
    win_count: number;
    loss_count: number;
    martingale_count: number;
    total_pnl_ckb: number;
    // Accumulated unsettled P&L waiting to cross the 61 CKB on-chain minimum
    pending_pnl_ckb: number;
};

export type AgentState = {
    walletAddress: string;
    remainingCapital: number;
    capitalInTrading: number;      // total CKB across all open buy positions
    lastDecision: TradeDecision | null;
    lastTradeWasLoss: boolean;
    consecutiveLosses: number;
    lastBuyPrice: number | null;
    lastBuyAmount: number | null;  // CKB amount of the last buy (for P&L calc)
    lastBuyTxHash: string | null;  // tx hash of the pending/confirmed buy TX
    pendingPnlCkb: number;         // unsettled P&L accumulator (real on-chain settlement)
};