import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { ccc } from "@ckb-ccc/core";

const RPC_URL = process.env.NEXT_PUBLIC_CKB_RPC_URL ?? "https://testnet.ckb.dev/rpc";

// Generous fee estimate: 1000 shannons/KB × ~500 bytes = ~500 shannons.
// We use 5000 shannons (~0.00005 CKB) to be safe.
const FEE_ESTIMATE_SHANNONS = 5000n;

// Min capacity for the owner output cell (secp256k1 lock, no data): 61 CKB
const MIN_OUTPUT_SHANNON = 6100000000n;

/**
 * POST /api/settings/withdraw
 * Body: { wallet_address: string }
 *
 * Sweeps ALL CKB from the trading wallet back to the owner address.
 *
 * Why not use completeInputsByCapacity + completeFeeBy:
 *   Those helpers are designed for partial sends. For a full sweep they
 *   leave a sub-61-CKB remainder that cannot form a valid change cell.
 *
 * Instead we:
 *   1. Collect every live cell from the trading wallet via the indexer RPC.
 *   2. Set output = total_inputs − fixed_fee_estimate.
 *   3. Send — no change cell, fee is the implicit capacity difference.
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
        .select("trading_address, is_running")
        .eq("wallet_address", body.wallet_address)
        .maybeSingle();

    if (fetchErr || !settings) {
        return NextResponse.json({ error: "Settings not found." }, { status: 404 });
    }

    const tradingAddr = settings.trading_address as
        | { address: string; private_key: string }
        | null;

    if (!tradingAddr?.private_key || !tradingAddr?.address) {
        return NextResponse.json({ error: "Trading wallet not found." }, { status: 404 });
    }

    const client = new ccc.ClientPublicTestnet();

    // Derive lock script for the trading wallet (needed to query cells)
    const tradingAddrObj = await ccc.Address.fromString(tradingAddr.address, client);
    const script = tradingAddrObj.script;

    // ── Collect ALL live cells via the indexer RPC ────────────────────────────
    type RpcCell = {
        out_point: { tx_hash: string; index: string };
        output: { capacity: string };
    };

    const liveCells: RpcCell[] = [];
    let cursor: string | null = null;

    do {
        const res: Response = await fetch(RPC_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: 1,
                jsonrpc: "2.0",
                method: "get_cells",
                params: [
                    {
                        script: {
                            code_hash: script.codeHash,
                            hash_type: script.hashType,
                            args: script.args,
                        },
                        script_type: "lock",
                        // Include cells that carry data (CAIT BUY/SELL memos)
                        filter: { output_data_len_range: ["0x0", "0xffffffff"] },
                    },
                    "asc",
                    "0x64",   // page size = 100
                    cursor,
                ],
            }),
        });

        const json: { result?: { objects?: RpcCell[]; last_cursor?: string } } = await res.json();
        const { objects, last_cursor } = json.result ?? {};
        if (!objects?.length) break;
        liveCells.push(...objects);
        cursor = last_cursor || null;
    } while (cursor);

    // ── Nothing to sweep ──────────────────────────────────────────────────────
    if (liveCells.length === 0) {
        await db
            .from("agent_settings")
            .update({ is_running: false, updated_at: new Date().toISOString() })
            .eq("wallet_address", body.wallet_address);

        return NextResponse.json({ tx_hash: null, message: "Nothing to withdraw." });
    }

    const totalShannon = liveCells.reduce(
        (sum, c) => sum + BigInt(c.output.capacity),
        0n
    );

    // Guard: output must be at least 61 CKB (minimum cell capacity)
    if (totalShannon <= MIN_OUTPUT_SHANNON + FEE_ESTIMATE_SHANNONS) {
        await db
            .from("agent_settings")
            .update({ is_running: false, updated_at: new Date().toISOString() })
            .eq("wallet_address", body.wallet_address);

        return NextResponse.json({
            tx_hash: null,
            message: "Balance too low to withdraw (below minimum cell size).",
        });
    }

    // ── Build sweep transaction ───────────────────────────────────────────────
    // output = total − fee.  No change cell; fee is the implicit capacity gap.
    const ownerAddrObj = await ccc.Address.fromString(body.wallet_address, client);
    const outputShannon = totalShannon - FEE_ESTIMATE_SHANNONS;

    const tx = ccc.Transaction.from({
        inputs: liveCells.map((cell) => ({
            previousOutput: {
                txHash: cell.out_point.tx_hash,
                index: parseInt(cell.out_point.index, 16),
            },
        })),
        outputs: [{ capacity: outputShannon, lock: ownerAddrObj.script }],
        outputsData: ["0x"],
    });

    // SignerCkbPrivateKey.sendTransaction handles:
    //   • addCellDepsOfKnownScripts  (fetches each input's lock from chain)
    //   • witness scaffolding + secp256k1 signing
    try {
        const tradingSigner = new ccc.SignerCkbPrivateKey(client, tradingAddr.private_key);
        const txHash = await tradingSigner.sendTransaction(tx);

        await db
            .from("agent_settings")
            .update({
                is_running: false,
                total_capital: 0,
                capital_in_trading: 0,
                updated_at: new Date().toISOString(),
            })
            .eq("wallet_address", body.wallet_address);

        return NextResponse.json({ tx_hash: txHash });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: `Transaction failed: ${msg}` }, { status: 500 });
    }
}
