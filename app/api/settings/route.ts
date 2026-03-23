import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import type { AgentSettings } from "@/lib/supabase";

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get("wallet");

    if (!wallet) {
        return NextResponse.json(
            { error: "wallet query param required" },
            { status: 400 }
        );
    }

    const db = createServiceClient();
    const { data, error } = await db
        .from("agent_settings")
        .select("*")
        .eq("wallet_address", wallet)
        .maybeSingle();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
    let body: Partial<AgentSettings>;

    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.wallet_address) {
        return NextResponse.json(
            { error: "wallet_address is required" },
            { status: 400 }
        );
    }

    const payload: AgentSettings = {
        wallet_address: body.wallet_address,
        likely_buy_price: body.likely_buy_price ?? 0,
        likely_sell_price: body.likely_sell_price ?? 0,
        total_capital: body.total_capital ?? 0,
        max_per_trade: body.max_per_trade ?? 0,
        is_running: body.is_running ?? false,
        updated_at: new Date().toISOString(),
        // Position tracking
        capital_in_trading: 0,
        last_buy_price: null,
        last_buy_amount: null,
        win_count: 0,
        loss_count: 0,
        martingale_count: 0,
        total_pnl_ckb: 0,
        pending_pnl_ckb: 0
    };

    const db = createServiceClient();
    const { data, error } = await db
        .from("agent_settings")
        .upsert(payload, { onConflict: "wallet_address" })
        .select()
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
}

export async function PATCH(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get("wallet");

    if (!wallet) {
        return NextResponse.json(
            { error: "wallet query param required" },
            { status: 400 }
        );
    }

    let body: Partial<AgentSettings>;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const db = createServiceClient();
    const { data, error } = await db
        .from("agent_settings")
        .update({ ...body, updated_at: new Date().toISOString() })
        .eq("wallet_address", wallet)
        .select()
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
}
