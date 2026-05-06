# MeridianWallet

Personal finance dashboard that connects your bank accounts via Teller (US) — with GoCardless (EU) planned — categorizes every transaction automatically, converts foreign-currency charges to USD using monthly-average ECB rates, and surfaces spending insights through a Claude-powered AI advisor.

## Architecture

```
Browser (Teller Connect + Dashboard)
  ↕
Express Server (Node.js)
  ├── lib/providers/teller.js  → US bank data via mTLS REST API
  ├── lib/providers/saltedge.js → 60+ non-US countries via SaltEdge hosted widget (stubbed)
  ├── lib/db.js                → JSON file storage (single-user local)
  └── Claude API               → categorization (Haiku) + advisor chat (Opus)
```

All data stays on your machine in a local JSON file (`meridianwallet-data.json`). Outbound network calls go to: Teller (`api.teller.io`) for bank data, Anthropic (`api.anthropic.com`) for AI categorization and chat, and Frankfurter (`api.frankfurter.app`) for ECB exchange rates. Nothing else.

## Setup

### 1. Sign up for Teller and download mTLS certs

1. Sign up at [teller.io](https://teller.io) and create an application
2. From the dashboard, generate a Teller Application Certificate (development tier is free, capped at ~100 connected accounts, no commercial agreement)
3. Download the `cert.pem` and `key.pem` files

### 2. Get an Anthropic API key

Get an API key at [console.anthropic.com](https://console.anthropic.com/settings/keys).

### 3. Install & run

```bash
# Clone or download this folder
git clone https://github.com/rebelStats/MeridianWallet.git
cd MeridianWallet

# Install dependencies (also wires up the pre-commit secret guard)
npm install

# Drop your Teller certs into ./certs/ (gitignored)
mkdir -p certs
mv ~/Downloads/cert.pem ./certs/teller-cert.pem
mv ~/Downloads/key.pem  ./certs/teller-key.pem

# Create your .env from the template and paste in your credentials
cp .env.example .env
# Then edit .env: TELLER_APPLICATION_ID, TELLER_ENVIRONMENT, ANTHROPIC_API_KEY

# Start the server
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 4. Connect your banks

1. Click **Connect** in the nav
2. Click the connect card — Teller Connect opens
3. Search for your bank and log in
4. Click **Sync transactions** to pull the last 365 days
5. Go to **Dashboard** to see your spending breakdown

You can also import CSV/PDF statements (e.g. Revolut Poland statements) via the import flow — they're parsed by Claude Haiku, currency-converted using monthly-average ECB rates, and deduped against existing data.

## Teller environments

| Environment | Use case | Real banks? |
|-------------|----------|-------------|
| `sandbox` | Testing with fake data | No — uses test credentials |
| `development` | Real banks, capped at ~100 connected accounts, free | Yes |
| `production` | Paid commercial tier | Yes — requires Teller approval |

For most personal use cases, **`development`** is the right tier.

## Non-US bank coverage (planned)

SaltEdge Account Information API is stubbed in `lib/providers/saltedge.js` and will be wired in once SaltEdge App-id + Secret credentials are configured. SaltEdge officially supports 60+ countries — full list is exposed by `GET /api/connect/countries`. The provider abstraction means it slots in alongside Teller without rewriting any other layer.

## Features

- **Multi-bank dashboard**: all your connected accounts in one view
- **Auto-categorization**: regex-first, AI-fallback, manual override per-merchant
- **Weekly trend chart**: clickable bars drill into Transactions tab with date filter pre-set
- **Recurring merchant tracking**: identifies habits by frequency + total spend
- **AI advisor chat**: Claude Opus 4.7 analyzes your last 90 days with daily/monthly subtotals
- **Multi-currency import**: CSV/PDF statements parsed by Haiku, USD conversion via monthly-average ECB rates
- **Refund handling**: refunds tracked as negative amounts that reduce net spend
- **Cross-source dedup**: importing data that overlaps existing records doesn't double-count
- **Local storage**: JSON file — your financial data never leaves your machine

## Tech stack

- **Backend**: Node.js, Express
- **Bank integration**: Teller (REST + mTLS)
- **AI**: Anthropic Claude API (Haiku for categorization, Opus for chat)
- **FX**: Frankfurter (ECB rates)
- **Frontend**: Vanilla HTML/CSS/JS, Chart.js, Teller Connect SDK
- **Storage**: Local JSON file (zero deps, no setup)

## Privacy

See [PRIVACY.md](PRIVACY.md) for what data the app handles, where it's stored, and what gets sent to third parties (Teller, Anthropic, Frankfurter).

## License

MIT — see [LICENSE](LICENSE).
