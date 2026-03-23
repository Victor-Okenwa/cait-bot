/**
 * Reserve wallet management for real on-chain P&L settlement.
 *
 * The agent reserve wallet (AGENT_PRIVATE_KEY / AGENT_WALLET_ADDRESS) holds a
 * CKB buffer that backs real settlement transfers:
 *
 *   Profit trade  → reserve sends pnl_ckb CKB to user's trading wallet
 *   Loss trade    → user's trading wallet sends |pnl_ckb| CKB to reserve
 *
 * Because CKB cells require a minimum of 61 CKB, small P&L amounts are
 * accumulated in `pending_pnl_ckb` (in DB) until the total crosses ±61 CKB,
 * then settled in a single on-chain transaction.
 *
 * The faucet is called automatically when the reserve balance drops below
 * LOW_RESERVE_THRESHOLD, with a 24-hour cooldown between requests.
 */

import { ccc } from "@ckb-ccc/core";
import { sendCKBWithMemo } from "@/lib/ccc";
import { getAddressBalanceCKB } from "@/lib/balance";

// ─── Constants ────────────────────────────────────────────────────────────────

const RESERVE_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY!;
const RESERVE_ADDRESS     = process.env.AGENT_WALLET_ADDRESS!;

/** CKB testnet faucet — one claim per address per 24 hours */
const FAUCET_API = "https://faucet-api.nervos.org/claim_events";

/** Trigger a faucet refill when reserve drops below this amount */
const LOW_RESERVE_THRESHOLD_CKB = 50_000;

/** Minimum CKB the reserve must retain after a profit payout (covers future TX fees) */
const RESERVE_FLOOR_CKB = 61;

/** Minimum CKB a user's trading wallet must retain after a loss collection */
const USER_FLOOR_CKB = 122; // 61 min cell + 61 buffer for next trade

const FAUCET_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

const EXPLORER_BASE = "https://testnet.explorer.nervos.org/transaction";

// ─── Singleton signer ─────────────────────────────────────────────────────────

const testnetClient = new ccc.ClientPublicTestnet();
let _reserveSigner: ccc.SignerCkbPrivateKey | null = null;

function getReserveSigner(): ccc.SignerCkbPrivateKey {
    if (!_reserveSigner) {
        _reserveSigner = new ccc.SignerCkbPrivateKey(testnetClient, RESERVE_PRIVATE_KEY);
    }
    return _reserveSigner;
}

// ─── Faucet refill (24h cooldown) ─────────────────────────────────────────────

let lastFaucetRequestAt = 0;

/**
 * Check reserve balance; if below threshold and cooldown has passed, request
 * testnet CKB from the faucet.  Safe to call on every tick — guards itself.
 */
export async function maybeRefillReserve(): Promise<void> {
    const balance = await getReserveBalance();

    if (balance >= LOW_RESERVE_THRESHOLD_CKB) return;

    const now = Date.now();
    if (now - lastFaucetRequestAt < FAUCET_COOLDOWN_MS) {
        console.log(
            `⛽  Reserve low (${balance.toFixed(0)} CKB) but faucet cooldown active — skipping.`
        );
        return;
    }

    console.log(`⛽  Reserve low (${balance.toFixed(0)} CKB) — requesting faucet funds for ${RESERVE_ADDRESS.slice(0, 16)}...`);

    try {
        const res = await fetch(FAUCET_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ claim_events: { address_hash: RESERVE_ADDRESS } }),
        });

        if (res.ok) {
            console.log("✅  Faucet request submitted — funds will arrive shortly.");
            lastFaucetRequestAt = now;
        } else {
            const text = await res.text().catch(() => "");
            console.warn(`⚠️   Faucet responded ${res.status}: ${text.slice(0, 120)}`);
        }
    } catch (err) {
        console.error("❌  Faucet request error:", err);
    }
}

// ─── Balance helpers ──────────────────────────────────────────────────────────

export function getReserveBalance(): Promise<number> {
    return getAddressBalanceCKB(RESERVE_ADDRESS);
}

export function getReserveAddress(): string {
    return RESERVE_ADDRESS;
}

// ─── Settlement ───────────────────────────────────────────────────────────────

export type SettlementResult = {
    txHash: string;
    explorerLink: string;
    /** Actual CKB moved (may be less than requested if wallet was constrained) */
    amountCKB: number;
};

/**
 * Profit settlement: reserve → user trading wallet.
 *
 * Returns null if the reserve has insufficient funds (faucet refill is
 * attempted asynchronously for next time).
 */
export async function sendProfitToUser(
    userTradingAddress: string,
    amountCKB: number,
    tradePrice: number
): Promise<SettlementResult | null> {
    const reserveBalance = await getReserveBalance();
    const needed = amountCKB + RESERVE_FLOOR_CKB;

    if (reserveBalance < needed) {
        console.warn(
            `⚠️   Reserve too low for profit payout ` +
            `(${reserveBalance.toFixed(2)} CKB available, ${needed.toFixed(2)} needed). ` +
            `Accumulating for next settlement.`
        );
        void maybeRefillReserve(); // fire-and-forget — balance may arrive next tick
        return null;
    }

    try {
        const signer = getReserveSigner();
        const memo = `CAIT PROFIT +${amountCKB.toFixed(2)} CKB @ $${tradePrice.toFixed(6)}`;
        const { txHash } = await sendCKBWithMemo(signer, userTradingAddress, amountCKB, memo);
        console.log(`💸  Profit paid: +${amountCKB.toFixed(2)} CKB → user trading wallet. TX: ${txHash}`);
        return { txHash, explorerLink: `${EXPLORER_BASE}/${txHash}`, amountCKB };
    } catch (err) {
        console.error("❌  Profit payout TX failed:", err);
        return null;
    }
}

/**
 * Loss settlement: user trading wallet → reserve.
 *
 * If the user's wallet cannot cover the full loss without dropping below
 * USER_FLOOR_CKB, we collect as much as possible and return the actual amount.
 * Returns null if the wallet is already too low to send anything.
 */
export async function collectLossFromUser(
    userSigner: ccc.SignerCkbPrivateKey,
    userTradingAddress: string,
    amountCKB: number,
    tradePrice: number
): Promise<SettlementResult | null> {
    const userBalance = await getAddressBalanceCKB(userTradingAddress);
    const maxCollectable = userBalance - USER_FLOOR_CKB;

    if (maxCollectable < 61) {
        console.warn(
            `⚠️   User trading wallet too low to collect loss ` +
            `(${userBalance.toFixed(2)} CKB, need ${(amountCKB + USER_FLOOR_CKB).toFixed(2)}). ` +
            `Skipping on-chain collection.`
        );
        return null;
    }

    const actualAmount = Math.min(amountCKB, maxCollectable);
    if (actualAmount < amountCKB) {
        console.warn(
            `⚠️   Partial loss collection: ${actualAmount.toFixed(2)} of ${amountCKB.toFixed(2)} CKB ` +
            `(user wallet constrained).`
        );
    }

    try {
        const memo = `CAIT LOSS -${actualAmount.toFixed(2)} CKB @ $${tradePrice.toFixed(6)}`;
        const { txHash } = await sendCKBWithMemo(userSigner, RESERVE_ADDRESS, actualAmount, memo);
        console.log(`📉  Loss collected: -${actualAmount.toFixed(2)} CKB → reserve. TX: ${txHash}`);
        return { txHash, explorerLink: `${EXPLORER_BASE}/${txHash}`, amountCKB: actualAmount };
    } catch (err) {
        console.error("❌  Loss collection TX failed:", err);
        return null;
    }
}
