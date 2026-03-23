import { NextRequest, NextResponse } from "next/server";
import { tick } from "@/agent/index";

/**
 * GET /api/agent/tick
 *
 * Called every minute by Vercel Cron (configured in vercel.json).
 * Vercel automatically sets CRON_SECRET and passes it as:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Direct calls without the correct secret are rejected with 401.
 *
 * Vercel function timeout:
 *   - Hobby plan: 10s  (too short — agent tick can take 10–20s)
 *   - Pro plan:   60s  ✓
 *   - Enterprise: 300s ✓
 * Set maxDuration to the highest your plan allows.
 */
export const maxDuration = 60;

export async function GET(req: NextRequest) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const started = Date.now();

    try {
        await tick();
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        return NextResponse.json({ ok: true, elapsed: `${elapsed}s` });
    } catch (err) {
        console.error("❌  Agent tick error:", err);
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
