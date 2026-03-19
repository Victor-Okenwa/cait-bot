import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get("wallet");
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "50"), 200);
    const type = searchParams.get("type"); // optional filter: buy | sell | hold | wait                                          

    if (!wallet) {
        return NextResponse.json(
            { error: "wallet query param required" },
            { status: 400 }
        );
    }

    const db = createServiceClient();

    let query = db
        .from("trades")
        .select("*")
        .eq("wallet_address", wallet)
        .order("timestamp", { ascending: false })
        .limit(limit);

    if (type) {
        query = query.eq("type", type);
    }

    const { data, error } = await query;

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data, count: data?.length ?? 0 });
}

export async function POST(req: NextRequest) {
    let body: Record<string, unknown>;

    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.wallet_address || !body.type || body.price === undefined) {
        return NextResponse.json(
            { error: "wallet_address, type, and price are required" },
            { status: 400 }
        );
    }

    const validTypes = ["buy", "sell", "hold", "wait"];
    if (!validTypes.includes(body.type as string)) {
        return NextResponse.json(
            { error: `type must be one of: ${validTypes.join(", ")}` },
            { status: 400 }
        );
    }

    const db = createServiceClient();
    const { data, error } = await db
        .from("trades")
        .insert({
            wallet_address: body.wallet_address,
            timestamp: new Date().toISOString(),
            type: body.type,
            amount: body.amount ?? 0,
            price: body.price,
            reason: body.reason ?? null,
            martingale: body.martingale ?? false,
            tx_hash: body.tx_hash ?? null,
            explorer_link: body.explorer_link ?? null,
        })
        .select()
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get("wallet");
    const id = searchParams.get("id");

    if (!wallet) {
        return NextResponse.json(
            { error: "wallet query param required" },
            { status: 400 }
        );
    }

    const db = createServiceClient();

    // Delete single trade by id, or all trades for wallet
    const query = id
        ? db.from("trades").delete().eq("id", id).eq("wallet_address", wallet)
        : db.from("trades").delete().eq("wallet_address", wallet);

    const { error } = await query;

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
}
