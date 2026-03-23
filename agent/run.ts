/**
 * Standalone agent runner — used on Render (Background Worker) and locally.
 *
 *   bun run agent/run.ts
 *
 * For Vercel deployments the agent runs via the cron route instead:
 *   app/api/agent/tick/route.ts  (triggered every minute by Vercel Cron)
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { tick } from "./index";

const INTERVAL_MS = 60_000;

console.log("🚀  CAIT Agent starting on CKB Testnet...");
console.log(`⏱  Interval: ${INTERVAL_MS / 1000}s`);
console.log("🔑  Using per-user trading wallets (no shared agent key required)\n");

tick(); // run immediately on start
setInterval(tick, INTERVAL_MS);
