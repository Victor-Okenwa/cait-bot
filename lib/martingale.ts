export type MartingaleState = {
    lastTradeWasLoss: boolean;
    consecutiveLosses: number;
};

/**                                                                          
 * Calculate the trade size for the current cycle.                           
 *                                                                           
 * Rules:                                                                    
 * - Normal trade: half of maxPerTrade                                       
 * - After a loss: double the previous size (Martingale)                     
 * - Never exceed maxPerTrade
 * - Never exceed remainingCapital                                           
 */
export function calculateTradeSize(
    maxPerTrade: number,
    remainingCapital: number,
    state: MartingaleState
): { amount: number; isMartingale: boolean } {
    const base = maxPerTrade / 2;
    const multiplier = Math.pow(2, state.consecutiveLosses);
    const desired = state.lastTradeWasLoss ? base * multiplier : base;

    const capped = Math.min(desired, maxPerTrade);
    const amount = Math.min(capped, remainingCapital);

    return {
        amount,
        isMartingale: state.lastTradeWasLoss && state.consecutiveLosses > 0,
    };
}

/**             
 * Update Martingale state after a trade result.
 * A "loss" in this context means we bought but price went down,
 * or we sold but price went up — tracked externally by the agent.           
 */
export function updateMartingaleState(
    state: MartingaleState,
    wasLoss: boolean
): MartingaleState {
    if (wasLoss) {
        return {
            lastTradeWasLoss: true,
            consecutiveLosses: state.consecutiveLosses + 1,
        };
    }
    return {
        lastTradeWasLoss: false,
        consecutiveLosses: 0,
    };
}

export function initialMartingaleState(): MartingaleState {
    return {
        lastTradeWasLoss: false,
        consecutiveLosses: 0,
    };
}             