# CAIT – Claw Artificial Intelligent Trader

> Built for the [Claw & Order: CKB AI Agent Hackathon](https://talk.nervos.org/t/claw-order-ckb-ai-agent-hackathon-announcement/10038) · CKB Testnet · March 2026

CAIT is an autonomous AI trading agent for CKB (Nervos Network). It monitors the live CKB/USD price, uses Claude Opus to decide when to buy or sell within your configured price windows, applies a Martingale position-sizing strategy to recover from losses, and executes on-chain transactions on CKB Testnet — all with a clean real-time dashboard UI.

---

## Features

- **Live CKB/USD price chart** — polls CoinGecko every 60 seconds, renders a rolling 30-point line chart
- **AI trade decisions** — Claude Opus evaluates price trend, distance to targets, capital state, and recent history to return `buy_now`, `buy_early`, `sell_now`, `sell_early`, `hold`, or `wait`
- **Martingale sizing** — normal trades use half of `maxPerTrade`; after a loss, size doubles (capped at `maxPerTrade` and remaining capital)
- **On-chain execution** — every buy/sell is a real CKB testnet transaction with a UTF-8 memo (e.g. `CAIT BUY 500.00 CKB @ $0.012345`)
- **Live trade log** — timestamped table of every decision with AI reason, Martingale flag, and testnet explorer link
- **Wallet connect** — CCC connector supports JoyID, MetaMask Snap, and other CKB-compatible wallets
- **Supabase persistence** — agent settings and trade history stored and synced in real time

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 App Router + shadcn/ui + Tailwind CSS |
| Wallet | @ckb-ccc/connector-react (CCC) |
| AI | Claude Opus via Anthropic SDK |
| Blockchain | CKB Testnet RPC + @ckb-ccc/core |
| Database | Supabase (PostgreSQL) |
| Price feed | CoinGecko API (`nervos-network`) |
| Agent runner | Bun (TypeScript, separate terminal process) |

---

## Project Structure

```
ckb-ai-trader/
├── app/
│   ├── page.tsx                  # CAIT dashboard
│   ├── layout.tsx                # Root layout + metadata
│   ├── layoutProvider.tsx        # CCC wallet provider
│   └── api/
│       ├── settings/route.ts     # GET/POST/PATCH agent_settings
│       └── trades/route.ts       # GET/POST/DELETE trades
├── components/
│   ├── WalletConnect.tsx         # Wallet button with balance + address
│   ├── PriceChart.tsx            # Live CKB/USD recharts line chart
│   ├── AgentControls.tsx         # Settings form + Start/Stop switch
│   └── TradeLog.tsx              # Live trade history table
├── lib/
│   ├── supabase.ts               # Supabase client + types
│   ├── price.ts                  # CoinGecko fetch + rolling history
│   ├── agent-decision.ts         # Claude Opus decision logic
│   ├── martingale.ts             # Position sizing + state management
│   └── ccc.ts                    # CKB transaction builder (memo transfer)
├── agent/
│   ├── index.ts                  # Agent loop (runs every 60s)
│   └── types.ts                  # Shared TypeScript types
├── utils/
│   └── stringUtils.ts            # Address truncation + balance formatting
├── SUPABASE_SETUP.md             # Supabase SQL + RLS setup guide
├── AGENT_SETUP.md                # Private key generation + funding guide
└── .env.local                    # Environment variables (not committed)
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
bunx shadcn@latest add button card input label table badge switch skeleton
```

---

### 2. Set up Supabase

See **[SUPABASE_SETUP.md](./SUPABASE_SETUP.md)** for full SQL.

Two tables are required:

```sql
create table agent_settings (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null unique,
  likely_buy_price numeric not null default 0,
  likely_sell_price numeric not null default 0,
  total_capital numeric not null default 0,
  max_per_trade numeric not null default 0,
  is_running boolean not null default false,
  updated_at timestamptz not null default now()
);

create table trades (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  timestamp timestamptz not null default now(),
  type text not null check (type in ('buy', 'sell', 'hold', 'wait')),
  amount numeric not null default 0,
  price numeric not null default 0,
  reason text,
  martingale boolean not null default false,
  tx_hash text,
  explorer_link text
);
```

---

### 3. Generate agent wallet + fund it

See **[AGENT_SETUP.md](./AGENT_SETUP.md)** for full instructions. Quick option using Bun:

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

Fund the wallet at [faucet.nervos.org](https://faucet.nervos.org) (10,000 CKB per claim).

---

### 4. Configure environment

Create `.env.local` in the project root:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# CKB Testnet
NEXT_PUBLIC_CKB_RPC_URL=https://testnet.ckb.dev/rpc
NEXT_PUBLIC_IS_MAINNET=false

# Agent wallet (testnet only)
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
bun run agent/index.ts
```

---

## How It Works

### Agent Decision Flow (every 60 seconds)

```
Fetch CKB price (CoinGecko)
        │
        ▼
Is price within ±25% of buy OR sell target?
   No → log "wait", skip Claude call
   Yes ↓
        ▼
Call Claude Opus with full market context
   → decision: buy_now | buy_early | sell_now | sell_early | hold | wait
   → reason: one-sentence explanation
   → confidence: 0–100
        │
        ▼
Calculate trade size (Martingale logic)
   Normal: maxPerTrade / 2
   After loss: previous size × 2 (capped at maxPerTrade & remaining capital)
        │
        ▼
Send CKB transaction with memo (via CCC)
        │
        ▼
Save trade record to Supabase
Update remaining capital
```

### Martingale Strategy

| Situation | Trade Size |
|---|---|
| Normal trade | `maxPerTrade / 2` |
| After 1 loss | `maxPerTrade / 2 × 2` = `maxPerTrade` |
| After 2 losses | capped at `maxPerTrade` |
| Remaining capital < 61 CKB | agent holds, no trade |

---

## API Routes

| Method | Route | Description |
|---|---|---|
| GET | `/api/settings?wallet=ckt1...` | Fetch agent settings for a wallet |
| POST | `/api/settings` | Create or update agent settings |
| PATCH | `/api/settings?wallet=ckt1...` | Partial update (e.g. toggle is_running) |
| GET | `/api/trades?wallet=ckt1...` | Fetch trade history (supports `limit`, `type` filters) |
| POST | `/api/trades` | Insert a trade record |
| DELETE | `/api/trades?wallet=ckt1...&id=...` | Delete one or all trades for a wallet |

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
