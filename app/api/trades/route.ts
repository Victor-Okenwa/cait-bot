import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get("wallet");
    const pageSize = Math.min(parseInt(searchParams.get("limit") ?? "25"), 200);
    const offset = Math.max(parseInt(searchParams.get("offset") ?? "0"), 0);
    const sortCol = searchParams.get("sort") ?? "timestamp"; // column to sort by
    const sortDir = searchParams.get("dir") ?? "desc"; // asc | desc
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
        .select("*", { count: "exact" })
        .eq("wallet_address", wallet)
        .order(sortCol, { ascending: sortDir === "asc" })
        .range(offset, offset + pageSize - 1);

    if (type) {
        query = query.eq("type", type);
    }

    const { data, error, count } = await query;

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data, count: count ?? 0 });
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
    let body: { wallet: string; ids: string[] };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.wallet || !Array.isArray(body.ids) || body.ids.length === 0) {
        return NextResponse.json(
            { error: "wallet and ids[] are required" },
            { status: 400 }
        );
    }

    const db = createServiceClient();
    const { error } = await db
        .from("trades")
        .delete()
        .eq("wallet_address", body.wallet)
        .in("id", body.ids);

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
}
