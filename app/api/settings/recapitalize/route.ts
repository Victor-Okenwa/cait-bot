import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { getAddressBalanceCKB } from "@/lib/balance";
import { ccc } from "@ckb-ccc/core";
import type { TradingAddress } from "@/lib/supabase";

const EXPLORER_BASE = "https://testnet.explorer.nervos.org/transaction";
// Minimum CKB for a cell output — transfers below this aren't possible on-chain
const MIN_TRANSFER_CKB = 61;
// Buffer left in trading wallet to cover the refund tx fee (~0.001 CKB typical)
const FEE_BUFFER_CKB = 0.1;

/**
 * POST /api/settings/recapitalize
 * Body: { wallet_address: string, new_capital: number }
 *
 * Computes the delta between the trading wallet's actual on-chain balance and
 * the desired new_capital, then acts on it:
 *
 *   delta > MIN_TRANSFER → action: "deposit"
 *     No server tx. Client must send `amount` CKB to the trading wallet.
 *
 *   delta < -MIN_TRANSFER → action: "refund_done"
 *     Server sends the excess back to the user's main wallet.
 *     No further client tx needed.
 *
 *   |delta| < MIN_TRANSFER → action: "none"
 *     Balances already match within the transfer minimum. No tx needed.
 */
export async function POST(req: NextRequest) {
    let body: { wallet_address: string; new_capital: number };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.wallet_address || body.new_capital == null) {
        return NextResponse.json(
            { error: "wallet_address and new_capital are required" },
            { status: 400 }
        );
    }

    const db = createServiceClient();

    const { data: settings, error: fetchErr } = await db
        .from("agent_settings")
        .select("capital_in_trading, trading_address")
        .eq("wallet_address", body.wallet_address)
        .maybeSingle();

    if (fetchErr) {
        return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    }

    if (settings && (settings.capital_in_trading ?? 0) > 0) {
        return NextResponse.json(
            {
                error:
                    "Cannot change capital while the agent has an open trade position. " +
                    "Wait for the agent to sell first.",
            },
            { status: 409 }
        );
    }

    const tradingInfo = settings?.trading_address as TradingAddress | null;

    // ── Read actual on-chain balance ──────────────────────────────────────────
    const onChainBalance = tradingInfo?.address
        ? await getAddressBalanceCKB(tradingInfo.address)
        : 0;

    console.log(
        `[recapitalize] on-chain: ${onChainBalance.toFixed(4)} CKB  |  requested: ${body.new_capital} CKB`
    );

    const delta = body.new_capital - onChainBalance; // positive = need to deposit, negative = need to refund

    // ── Case 1: Need to deposit more (delta is positive and large enough) ─────
    if (delta >= MIN_TRANSFER_CKB) {
        return NextResponse.json({
            action: "deposit",
            amount: delta,
            on_chain_balance: onChainBalance,
        });
    }

    // ── Case 2: Need to refund excess (delta is negative and large enough) ────
    if (delta <= -MIN_TRANSFER_CKB && tradingInfo?.private_key) {
        const refundCKB = Math.abs(delta) - FEE_BUFFER_CKB;

        if (refundCKB >= MIN_TRANSFER_CKB) {
            try {
                const client = new ccc.ClientPublicTestnet();
                const tradingSigner = new ccc.SignerCkbPrivateKey(client, tradingInfo.private_key);
                const toScript = await ccc.Address.fromString(body.wallet_address, client);

                const tx = ccc.Transaction.from({
                    outputs: [
                        {
                            capacity: ccc.fixedPointFrom(refundCKB.toFixed(8)),
                            lock: toScript.script,
                        },
                    ],
                    outputsData: [stringToHex(`CAIT REFUND ${refundCKB.toFixed(2)} CKB`)],
                });

                await tx.completeInputsByCapacity(tradingSigner);
                await tx.completeFeeBy(tradingSigner, 1000);
                const refundTxHash = await tradingSigner.sendTransaction(tx);

                console.log(
                    `[recapitalize] Refunded ${refundCKB.toFixed(4)} CKB → ${body.wallet_address} | tx: ${refundTxHash}`
                );

                return NextResponse.json({
                    action: "refund_done",
                    refunded_amount: refundCKB,
                    on_chain_balance: onChainBalance,
                    refund_tx_hash: refundTxHash,
                    refund_explorer_link: `${EXPLORER_BASE}/${refundTxHash}`,
                });
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return NextResponse.json(
                    { error: `Refund transaction failed: ${msg}` },
                    { status: 500 }
                );
            }
        }
    }

    // ── Case 3: Delta within MIN_TRANSFER — nothing to do ────────────────────
    return NextResponse.json({
        action: "none",
        on_chain_balance: onChainBalance,
    });
}

function stringToHex(str: string): string {
    const bytes = new TextEncoder().encode(str);
    return "0x" + Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
