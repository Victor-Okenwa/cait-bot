import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { ccc } from "@ckb-ccc/core";
import type { TradingAddress } from "@/lib/supabase";

const EXPLORER_BASE = "https://testnet.explorer.nervos.org/transaction";

/**
 * POST /api/settings/recapitalize
 *
 * 1. Checks for an open trade position — blocks if capital_in_trading > 0.
 * 2. If the user's trading wallet holds capital (total_capital > 0), sends it
 *    back to the user's main connected wallet using the trading wallet's key.
 * 3. Updates the DB row to total_capital = 0, is_running = false.
 *
 * The caller is responsible for sending new capital to the trading wallet and
 * then upserting the final settings.
 */
export async function POST(req: NextRequest) {
    let body: { wallet_address: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.wallet_address) {
        return NextResponse.json({ error: "wallet_address is required" }, { status: 400 });
    }

    const db = createServiceClient();

    const { data: settings, error: fetchErr } = await db
        .from("agent_settings")
        .select("total_capital, capital_in_trading, trading_address")
        .eq("wallet_address", body.wallet_address)
        .maybeSingle();

    if (fetchErr) {
        return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    }

    // ── Block if agent has an open position ──────────────────────────────────
    if (settings && (settings.capital_in_trading ?? 0) > 0) {
        return NextResponse.json(
            {
                error:
                    "Cannot recapitalize while the agent has an open trade position. " +
                    "Wait for the agent to sell before changing capital.",
            },
            { status: 409 }
        );
    }

    const oldCapital: number = settings?.total_capital ?? 0;
    const tradingInfo = settings?.trading_address as TradingAddress | null;
    let refundTxHash: string | undefined;

    // ── Refund old capital from trading wallet → user's main wallet ──────────
    // Uses the trading wallet's own private key — it holds the actual CKB.
    if (oldCapital >= 61 && tradingInfo?.private_key) {
        try {
            const client = new ccc.ClientPublicTestnet();
            const tradingSigner = new ccc.SignerCkbPrivateKey(client, tradingInfo.private_key);

            const toScript = await ccc.Address.fromString(body.wallet_address, client);
            const amountShannon = ccc.fixedPointFrom(oldCapital.toFixed(8));

            const tx = ccc.Transaction.from({
                outputs: [{ capacity: amountShannon, lock: toScript.script }],
                outputsData: [stringToHex(`CAIT REFUND ${oldCapital.toFixed(2)} CKB`)],
            });

            await tx.completeInputsByCapacity(tradingSigner);
            await tx.completeFeeBy(tradingSigner, 1000);
            refundTxHash = await tradingSigner.sendTransaction(tx);

            console.log(
                `[recapitalize] Refunded ${oldCapital} CKB from trading wallet → ${body.wallet_address} | tx: ${refundTxHash}`
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return NextResponse.json(
                { error: `Refund transaction failed: ${msg}` },
                { status: 500 }
            );
        }
    }

    // ── Zero out capital in DB ────────────────────────────────────────────────
    if (settings) {
        await db
            .from("agent_settings")
            .update({
                total_capital: 0,
                capital_in_trading: 0,
                is_running: false,
                updated_at: new Date().toISOString(),
            })
            .eq("wallet_address", body.wallet_address);
    }

    return NextResponse.json({
        old_capital: oldCapital,
        refund_tx_hash: refundTxHash,
        refund_explorer_link: refundTxHash
            ? `${EXPLORER_BASE}/${refundTxHash}`
            : undefined,
    });
}

function stringToHex(str: string): string {
    const bytes = new TextEncoder().encode(str);
    return "0x" + Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
