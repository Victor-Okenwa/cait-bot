# CAIT – Claw Artificial Intelligent Trader

> Built for the [Claw & Order: CKB AI Agent Hackathon](https://talk.nervos.org/t/claw-order-ckb-ai-agent-hackathon-announcement/10038) · CKB Testnet · March 2026

CAIT is an autonomous AI trading agent for CKB (Nervos Network). It monitors the live CKB/USD price, uses Claude Opus to decide when to buy or sell within your configured price windows, applies a Martingale position-sizing strategy, executes on-chain transactions on CKB Testnet, and settles real profits and losses between a reserve wallet and each user's dedicated trading wallet.

---

## Features

- **Live CKB/USD price chart** — multiple durations (1m through 30d), line/area and candlestick modes, auto-scrolls to latest data, horizontal scroll for dense data
- **AI trade decisions** — Claude Opus evaluates price trend, open position, unrealised P&L, and stop-loss status to return `buy_now`, `buy_early`, `sell_now`, `sell_early`, `hold`, or `wait`
- **Position-aware decision engine** — when no position is held only buy signals are considered; when a position is open only sell signals are considered; Claude is never asked about the irrelevant side
- **Stop-loss enforcement** — if price falls ≥ 5% below the buy price the agent forces `sell_now` both in the AI prompt and as a hard in-code override
- **Martingale sizing** — normal trades use half of `maxPerTrade`; after a loss the size doubles (capped at `maxPerTrade` and remaining capital)
- **Full-position sells** — the sell amount is strictly equal to `capital_in_trading` (total CKB held across all open buys); partial sells are blocked
- **Real on-chain P&L settlement** — profits are paid from a reserve wallet to the user's trading wallet; losses are collected from the trading wallet back to the reserve; amounts below 61 CKB (CKB minimum cell size) accumulate until settleable
- **Reserve auto-refill** — when the reserve balance drops below 50,000 CKB the agent calls the CKB testnet faucet (24-hour cooldown guard)
- **Dedicated per-user trading wallets** — each user gets a unique CKB keypair; no shared signing key
- **On-chain execution** — every buy/sell is a real CKB testnet transaction with a UTF-8 memo (e.g. `CAIT BUY 500.00 CKB @ $0.012345`)
- **Capital deposit flow** — users transfer CKB from their own wallet to their trading wallet via the settings panel; the simulation capital tracks the result
- **Interactive trade log** — sortable columns (asc/desc), row checkboxes, bulk delete, paginated (25/50/100 rows), lazy-loaded from Supabase
- **Wallet balance refresh** — dedicated refresh button in the navbar refetches the owner wallet's live on-chain balance
- **Supabase persistence** — agent settings, open position, stats, and full trade history persisted and synced in real time

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 App Router + shadcn/ui + Tailwind CSS |
| Wallet | @ckb-ccc/connector-react (CCC) |
| AI | Claude Opus 4.6 via Anthropic SDK |
| Blockchain | CKB Testnet RPC + @ckb-ccc/core |
| Database | Supabase (PostgreSQL) |
| Price feed | CoinGecko API (`nervos-network`) |
| Agent runner | Bun (TypeScript, separate terminal process) |

---

## Project Structure

```
ckb-ai-trader/
├── app/
│   ├── page.tsx                        # CAIT dashboard
│   ├── layout.tsx                      # Root layout + metadata
│   ├── layoutProvider.tsx              # CCC wallet provider
│   └── api/
│       ├── price/route.ts              # CoinGecko proxy (simple, chart, ohlc)
│       ├── settings/route.ts           # GET/POST/PATCH agent_settings
│       ├── settings/recapitalize/      # Deposit amount validation
│       └── trades/route.ts             # GET/POST/DELETE trades (paginated)
├── components/
│   ├── WalletConnect.tsx               # Wallet pill + balance refresh button
│   ├── PriceChart.tsx                  # CKB/USD chart (line + candlestick)
│   ├── AgentControls.tsx               # Settings form + deposit + Start/Stop
│   └── TradeLog.tsx                    # Paginated, sortable, selectable trade table
├── lib/
│   ├── supabase.ts                     # Supabase client + types
│   ├── price.ts                        # CoinGecko fetch + rolling history
│   ├── agent-decision.ts               # Claude Opus prompt + decision parsing
│   ├── martingale.ts                   # Position sizing + state management
│   ├── ccc.ts                          # CKB transaction builder (memo transfer)
│   ├── balance.ts                      # On-chain CKB balance lookup
│   └── reserve.ts                      # Reserve wallet: faucet refill + P&L settlement
├── agent/
│   ├── index.ts                        # Agent loop (runs every 60s)
│   └── types.ts                        # Shared TypeScript types
├── utils/
│   └── stringUtils.ts                  # Address truncation + balance formatting
├── SUPABASE_SETUP.md                   # Supabase SQL + RLS setup guide
├── AGENT_SETUP.md                      # Private key generation + funding guide
└── .env.local                          # Environment variables (not committed)
```

---

## Quick Start

### 1. Clone and install

```bash
git clone <your-repo-url>
cd ckb-ai-trader
bun install
```

Install additional dependencies:

```bash
bun add @supabase/supabase-js @anthropic-ai/sdk recharts lucide-react \
        class-variance-authority clsx tailwind-merge dotenv
```

Install shadcn/ui components:

```bash
bunx shadcn@latest init
bunx shadcn@latest add button card input label table badge switch skeleton checkbox tooltip scroll-area
```

---

### 2. Set up Supabase

See **[SUPABASE_SETUP.md](./SUPABASE_SETUP.md)** for full SQL and RLS policies.

Core tables:

```sql
create table agent_settings (
  id                uuid primary key default gen_random_uuid(),
  wallet_address    text not null unique,
  likely_buy_price  numeric not null default 0,
  likely_sell_price numeric not null default 0,
  total_capital     numeric not null default 0,
  max_per_trade     numeric not null default 0,
  is_running        boolean not null default false,
  updated_at        timestamptz not null default now(),
  -- Per-user dedicated trading wallet
  trading_address   jsonb,
  -- Open position tracking (persisted across agent restarts)
  capital_in_trading numeric not null default 0,
  last_buy_price    numeric,
  last_buy_amount   numeric,
  -- Unsettled P&L accumulator (real on-chain settlement)
  pending_pnl_ckb   numeric not null default 0,
  -- Stats
  win_count         integer not null default 0,
  loss_count        integer not null default 0,
  martingale_count  integer not null default 0,
  total_pnl_ckb     numeric not null default 0
);

create table trades (
  id            uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  timestamp     timestamptz not null default now(),
  type          text not null check (type in ('buy', 'sell', 'hold', 'wait')),
  amount        numeric not null default 0,
  price         numeric not null default 0,
  reason        text,
  martingale    boolean not null default false,
  tx_hash       text,
  explorer_link text,
  pnl_ckb       numeric,
  pnl_usd       numeric,
  profit_tx_hash text
);
```

If upgrading an existing deployment, run this migration:

```sql
alter table agent_settings add column if not exists pending_pnl_ckb numeric not null default 0;
```

---

### 3. Generate wallets

**Agent reserve wallet** (holds CKB for P&L settlement):

```bash
bun run -e "
const { ccc } = await import('@ckb-ccc/core');
const privKey = ccc.bytesFrom(crypto.getRandomValues(new Uint8Array(32)));
const privHex = '0x' + Array.from(privKey).map(b => b.toString(16).padStart(2,'0')).join('');
const client = new ccc.ClientPublicTestnet();
const signer = new ccc.SignerCkbPrivateKey(client, privHex);
const addr = await signer.getRecommendedAddress();
console.log('AGENT_PRIVATE_KEY=' + privHex);
console.log('AGENT_WALLET_ADDRESS=' + addr);
"
```

Fund the reserve wallet generously at [faucet.nervos.org](https://faucet.nervos.org) (10,000 CKB per claim, 24-hour cooldown). The agent auto-refills when the balance drops below 50,000 CKB, but a large initial balance prevents gaps.

User trading wallets are generated automatically when a user saves their settings for the first time — no manual step required.

---

### 4. Configure environment

Create `.env.local` in the project root:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Groq (free tier — https://console.groq.com)
GROQ_API_KEY=gsk_...

# CKB Testnet
NEXT_PUBLIC_CKB_RPC_URL=https://testnet.ckb.dev/rpc
NEXT_PUBLIC_IS_MAINNET=false

# Agent reserve wallet (testnet only — never commit this key)
AGENT_PRIVATE_KEY=0x...
AGENT_WALLET_ADDRESS=ckt1...
```

---

### 5. Run

**Frontend** (Terminal 1):
```bash
bun run dev
```
Open [http://localhost:3000](http://localhost:3000)

**Agent loop** (Terminal 2):
```bash
bun run agent/run.ts
```

> **Important:** after any changes to `agent/index.ts` or `lib/*.ts`, kill and restart the agent process — the running Bun process does not hot-reload.

---

## How It Works

### Agent Decision Flow (every 60 seconds)

```
Fetch CKB price (CoinGecko)
Check reserve wallet balance → refill from faucet if < 50,000 CKB
        │
        ▼
Is a position currently open?
   NO  → Is price in ±25% buy window?
           No  → log "wait", done
           Yes → ask Claude (buy context only)
   YES → Is price in ±25% sell window OR below stop-loss?
           No  → log "hold", done
           Yes → ask Claude (sell context only)
        │
        ▼
Claude Opus returns:
   decision: buy_now | buy_early | sell_now | sell_early | hold | wait
   reason: one-sentence explanation (max 100 chars)
   confidence: 0–100
        │
        ▼
Hard overrides (applied after Claude):
   • Stop-loss: if price ≥ 5% below buy price → force sell_now
   • No position → any sell decision → demote to hold
   • Position open → any buy decision → demote to hold
        │
        ▼
Calculate trade size
   Buy:  Martingale sizing (maxPerTrade/2 normal, maxPerTrade after loss)
   Sell: exactly capital_in_trading (full position close, no partial sells)
        │
        ▼
For sells: verify buy TX is confirmed on-chain before spending its output
        │
        ▼
Send CKB testnet transaction with memo (via CCC)
        │
        ▼
Settle P&L on-chain (real CKB transfer)
   Profit ≥ 61 CKB → reserve wallet → user trading wallet
   Loss   ≥ 61 CKB → user trading wallet → reserve wallet
   < 61 CKB either way → accumulate in pending_pnl_ckb until threshold reached
        │
        ▼
Save trade record to Supabase (includes profit_tx_hash if settled)
Update simulation capital, stats, open position in agent_settings
```

### Martingale Strategy

| Situation | Trade Size |
|---|---|
| Normal trade | `maxPerTrade / 2` |
| After 1 loss | `maxPerTrade` |
| After 2+ losses | capped at `maxPerTrade` |
| Remaining capital < 61 CKB | hold, no trade |

### P&L Settlement

Real CKB moves between wallets on every closed trade:

| Scenario | On-chain action |
|---|---|
| Profit ≥ 61 CKB | Reserve → user trading wallet |
| Loss ≥ 61 CKB | User trading wallet → reserve |
| \|P&L\| < 61 CKB | Accumulated in `pending_pnl_ckb` (persisted in DB) |
| Reserve < 50k CKB | Faucet requested (max once per 24 hours) |
| User wallet too low | Partial or skipped collection (user retains ≥ 122 CKB) |

---

## API Routes

| Method | Route | Description |
|---|---|---|
| GET | `/api/price?type=simple` | Current CKB/USD price (30s cache) |
| GET | `/api/price?type=chart&days=1` | Market chart data for line/area charts |
| GET | `/api/price?type=ohlc&days=1` | OHLC candle data |
| GET | `/api/settings?wallet=ckt1...` | Fetch agent settings for a wallet |
| POST | `/api/settings` | Create or update agent settings |
| PATCH | `/api/settings?wallet=ckt1...` | Partial update (e.g. toggle `is_running`) |
| POST | `/api/settings/recapitalize` | Validate a deposit amount before transfer |
| GET | `/api/trades?wallet=ckt1...&limit=25&offset=0&sort=timestamp&dir=desc` | Paginated trade history with exact count |
| POST | `/api/trades` | Insert a trade record |
| DELETE | `/api/trades` | Bulk delete trades by ID array `{ wallet, ids[] }` |

---

## Resources

- [Nervos CKB Documentation](https://docs.nervos.org)
- [CCC Documentation](https://docs.ckbccc.com)
- [CKB Testnet Explorer](https://testnet.explorer.nervos.org)
- [Nervos Pudge Faucet](https://faucet.nervos.org)
- [Anthropic Claude API](https://docs.anthropic.com)
- [Supabase Documentation](https://supabase.com/docs)
- [CKB AI MCP Server](https://mcp.ckbdev.com/ckbai)
- [Claw & Order Hackathon Announcement](https://talk.nervos.org/t/claw-order-ckb-ai-agent-hackathon-announcement/10038)

---

## Hackathon Submission

- **Event:** Claw & Order: CKB AI Agent Hackathon
- **Dates:** March 11 – March 25, 2026
- **Network:** CKB Testnet
- **Team:** Individual
