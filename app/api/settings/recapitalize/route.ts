import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { ccc } from "@ckb-ccc/core";

const EXPLORER_BASE = "https://testnet.explorer.nervos.org/transaction";

/**
 * POST /api/settings/recapitalize
 *
 * 1. Reads the user's current total_capital from the agent_settings DB row.
 * 2. If capital > 0, the agent server-wallet refunds it back to the user's address.
 * 3. Updates the DB row to total_capital = 0 (the caller is responsible for
 *    collecting the new capital on-chain and then upserting the final settings).
 *
 * Returns: { agent_wallet_address, old_capital, refund_tx_hash? }
 */
export async function POST(req: NextRequest) {
    const agentPrivateKey = process.env.AGENT_PRIVATE_KEY;
    const agentWalletAddress = process.env.AGENT_WALLET_ADDRESS;

    if (!agentPrivateKey || !agentWalletAddress) {
        return NextResponse.json(
            { error: "Agent wallet not configured on server." },
            { status: 500 }
        );
    }

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

    // ── Read current state ────────────────────────────────────────────────────
    const { data: settings, error: fetchErr } = await db
        .from("agent_settings")
        .select("total_capital, capital_in_trading, is_running")
        .eq("wallet_address", body.wallet_address)
        .maybeSingle();

    if (fetchErr) {
        return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    }

    // Block if the agent has an open trade position — capital is partially deployed
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
    let refundTxHash: string | undefined;

    // ── Refund old capital to user ────────────────────────────────────────────
    if (oldCapital >= 61) {
        try {
            const client = new ccc.ClientPublicTestnet();
            const agentSigner = new ccc.SignerCkbPrivateKey(client, agentPrivateKey);

            const toScript = await ccc.Address.fromString(body.wallet_address, client);
            const amountShannon = ccc.fixedPointFrom(oldCapital.toFixed(8));

            const tx = ccc.Transaction.from({
                outputs: [{ capacity: amountShannon, lock: toScript.script }],
                outputsData: [stringToHex(`CAIT REFUND ${oldCapital.toFixed(2)} CKB`)],
            });

            await tx.completeInputsByCapacity(agentSigner);
            await tx.completeFeeBy(agentSigner, 1000);
            refundTxHash = await agentSigner.sendTransaction(tx);

            console.log(
                `[recapitalize] Refunded ${oldCapital} CKB → ${body.wallet_address} | tx: ${refundTxHash}`
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return NextResponse.json(
                { error: `Refund transaction failed: ${msg}` },
                { status: 500 }
            );
        }
    }

    // ── Reset capital in DB to 0 so the slot is clean for the new deposit ────
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
        agent_wallet_address: agentWalletAddress,
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
