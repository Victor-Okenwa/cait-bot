import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { ccc } from "@ckb-ccc/core";
import { randomBytes } from "crypto";

/**
 * POST /api/settings/trading-wallet
 *
 * Returns the user's dedicated trading wallet, generating one if needed.
 * - If agent_settings row exists and trading_address is set → return existing
 * - If row exists but trading_address is null → generate, persist, return
 * - If no row yet → generate and return (client persists on next save)
 *
 * ⚠️  Private keys are stored in Supabase (custodial). Acceptable for a demo;
 * production would use encrypted storage or an HSM.
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

    // ── Check if already generated ───────────────────────────────────────────
    const { data: existing } = await db
        .from("agent_settings")
        .select("trading_address")
        .eq("wallet_address", body.wallet_address)
        .maybeSingle();

    if (existing?.trading_address) {
        return NextResponse.json({
            trading_address: existing.trading_address,
            is_new: false,
        });
    }

    // ── Generate new trading wallet ───────────────────────────────────────────
    const privateKey = "0x" + randomBytes(32).toString("hex");
    const client = new ccc.ClientPublicTestnet();
    const signer = new ccc.SignerCkbPrivateKey(client, privateKey);
    const address = await signer.getRecommendedAddress();
    const addressObj = await ccc.Address.fromString(address, client);

    const tradingAddress = {
        address,
        private_key: privateKey,
        lock_arg: addressObj.script.args,
    };

    // ── Persist if the row already exists (migration case) ───────────────────
    if (existing) {
        await db
            .from("agent_settings")
            .update({ trading_address: tradingAddress })
            .eq("wallet_address", body.wallet_address);
    }
    // If no row yet, client includes trading_address in the upsert on first save.

    return NextResponse.json({ trading_address: tradingAddress, is_new: true });
}
