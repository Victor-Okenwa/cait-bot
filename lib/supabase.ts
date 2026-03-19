import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Server-side client with service role (for agent writes)                   
export function createServiceClient() {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    return createClient(supabaseUrl, serviceRoleKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    });
}

export type AgentSettings = {
    id?: string;
    wallet_address: string;
    likely_buy_price: number;
    likely_sell_price: number;
    total_capital: number;
    max_per_trade: number;
    is_running: boolean;
    updated_at?: string;
};

export type Trade = {
    id?: string;
    wallet_address: string;
    timestamp?: string;
    type: "buy" | "sell" | "hold" | "wait";
    amount: number;
    price: number;
    reason: string;
    martingale: boolean;
    tx_hash?: string;
    explorer_link?: string;
};