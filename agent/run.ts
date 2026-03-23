/// <reference types="bun-types" />

/**
 * Standalone agent runner — used on Fly.io, Render, and locally.
 *
 *   bun run agent/run.ts
 *
 * Includes a lightweight health-check HTTP server on port 8080.
 * Visit the Fly.io app URL to see a live status page (green = OK, red = error).
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { tick } from "./index";

const INTERVAL_MS = 60_000;
const HEALTH_PORT = Number(process.env.PORT) || 8080;
const MAX_LOG_LINES = 80;

// ─── Health-check state ──────────────────────────────────────────────────────

const agentHealth = {
    startedAt: new Date(),
    lastTickAt: null as Date | null,
    lastTickOk: false,
    lastError: null as string | null,
    tickCount: 0,
    logLines: [] as string[],
};

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function captureLog(level: string, args: unknown[]) {
    const line = `[${new Date().toISOString()}] [${level}] ${args.map(String).join(" ")}`;
    agentHealth.logLines.push(line);
    if (agentHealth.logLines.length > MAX_LOG_LINES) {
        agentHealth.logLines.shift();
    }
}

console.log = (...args: unknown[]) => { captureLog("INFO", args); originalLog(...args); };
console.error = (...args: unknown[]) => { captureLog("ERROR", args); originalError(...args); };
console.warn = (...args: unknown[]) => { captureLog("WARN", args); originalWarn(...args); };

// ─── Wrapped tick with health tracking ───────────────────────────────────────

async function trackedTick() {
    try {
        await tick();
        agentHealth.lastTickAt = new Date();
        agentHealth.lastTickOk = true;
        agentHealth.lastError = null;
        agentHealth.tickCount++;
    } catch (err) {
        agentHealth.lastTickAt = new Date();
        agentHealth.lastTickOk = false;
        agentHealth.lastError = String(err);
        agentHealth.tickCount++;
    }
}

// ─── Health-check HTTP server ────────────────────────────────────────────────

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildStatusPage(): string {
    const now = new Date();
    const uptime = Math.floor((now.getTime() - agentHealth.startedAt.getTime()) / 1000);
    const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`;

    const neverTicked = agentHealth.lastTickAt === null;
    const tickAge = neverTicked ? Infinity : (now.getTime() - agentHealth.lastTickAt!.getTime()) / 1000;
    const stale = tickAge > 180; // no tick for 3 minutes = stale

    const isOk = !neverTicked && agentHealth.lastTickOk && !stale;
    const statusColor = isOk ? "#22c55e" : "#ef4444";
    const statusText = neverTicked ? "STARTING" : stale ? "STALE" : agentHealth.lastTickOk ? "OK" : "ERROR";

    const lastTickStr = agentHealth.lastTickAt
        ? `${agentHealth.lastTickAt.toISOString()} (${Math.floor(tickAge)}s ago)`
        : "never";

    const logsHtml = agentHealth.logLines
        .slice()
        .reverse()
        .map((l) => {
            const color = l.includes("[ERROR]") ? "#fca5a5" : l.includes("[WARN]") ? "#fde68a" : "#d1d5db";
            return `<div style="color:${color}">${escapeHtml(l)}</div>`;
        })
        .join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>CAIT Agent — ${statusText}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0f172a; color: #e2e8f0; font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace; padding: 24px; }
    .badge { display: inline-block; padding: 6px 20px; border-radius: 9999px; font-weight: 700; font-size: 1.25rem; color: #0f172a; background: ${statusColor}; }
    .grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; margin: 16px 0; }
    .label { color: #94a3b8; }
    .logs { background: #1e293b; border-radius: 8px; padding: 16px; margin-top: 16px; max-height: 60vh; overflow-y: auto; font-size: 0.8rem; line-height: 1.6; }
    h1 { font-size: 1.5rem; margin-bottom: 12px; }
    .error { color: #fca5a5; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>CAIT Agent</h1>
  <span class="badge">${statusText}</span>
  <div class="grid">
    <span class="label">Uptime</span><span>${uptimeStr}</span>
    <span class="label">Ticks</span><span>${agentHealth.tickCount}</span>
    <span class="label">Last tick</span><span>${lastTickStr}</span>
    <span class="label">Interval</span><span>${INTERVAL_MS / 1000}s</span>
  </div>
  ${agentHealth.lastError ? `<div class="error">Last error: ${escapeHtml(agentHealth.lastError)}</div>` : ""}
  <h1 style="margin-top:24px">Recent Logs</h1>
  <div class="logs">${logsHtml || "<div style='color:#94a3b8'>No logs yet.</div>"}</div>
</body>
</html>`;
}

Bun.serve({
    port: HEALTH_PORT,
    fetch() {
        return new Response(buildStatusPage(), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    },
});

// ─── Start agent ─────────────────────────────────────────────────────────────

console.log("🚀  CAIT Agent starting on CKB Testnet...");
console.log(`⏱  Interval: ${INTERVAL_MS / 1000}s`);
console.log(`🌐  Health-check server on port ${HEALTH_PORT}`);
console.log("🔑  Using per-user trading wallets (no shared agent key required)\n");

trackedTick();
setInterval(trackedTick, INTERVAL_MS);
