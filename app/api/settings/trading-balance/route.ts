import { NextRequest, NextResponse } from "next/server";
import { getAddressBalanceCKB } from "@/lib/balance";

/**
 * GET /api/settings/trading-balance?address=ckt1...
 *
 * Returns the live on-chain CKB balance of a trading wallet address.
 * Uses the CKB indexer (via CCC ClientPublicTestnet) to sum all live
 * cell capacities for the given lock script.
 */
export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const address = searchParams.get("address");

    if (!address) {
        return NextResponse.json(
            { error: "address query param required" },
            { status: 400 }
        );
    }

    const balance_ckb = await getAddressBalanceCKB(address);

    return NextResponse.json({ balance_ckb });
}
