import { NextRequest, NextResponse } from "next/server";
import { getAddressBalanceCKB } from "@/lib/balance";

const MIN_DEPOSIT_CKB = 60;

/**
 * POST /api/settings/recapitalize
 * Body: { wallet_address: string, new_capital: number }
 *
 * new_capital is the AMOUNT TO DEPOSIT this session (not the desired total):
 *
 *   new_capital === 0
 *     No deposit. Client may still save other settings.  → action: "none"
 *
 *   0 < new_capital < 60
 *     Below on-chain minimum cell size. Rejected.        → HTTP 400
 *
 *   new_capital >= 60
 *     Verify the owner wallet can cover the amount, then tell the
 *     client to send that many CKB to the trading wallet.  → action: "deposit"
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

    // 0 → user only wants to update settings, no deposit needed
    if (body.new_capital === 0) {
        return NextResponse.json({ action: "none" });
    }

    // Below minimum cell size
    if (body.new_capital < MIN_DEPOSIT_CKB) {
        return NextResponse.json(
            {
                error:
                    `Deposit amount must be at least ${MIN_DEPOSIT_CKB} CKB. ` +
                    `Enter 0 to update settings without depositing.`,
            },
            { status: 400 }
        );
    }

    // Verify the owner wallet has enough CKB to cover the deposit
    const ownerBalance = await getAddressBalanceCKB(body.wallet_address);
    if (ownerBalance < body.new_capital) {
        return NextResponse.json(
            {
                error:
                    `Insufficient balance. Your wallet has ${ownerBalance.toFixed(2)} CKB ` +
                    `but you are trying to deposit ${body.new_capital} CKB.`,
            },
            { status: 400 }
        );
    }

    return NextResponse.json({ action: "deposit", amount: body.new_capital });
}
