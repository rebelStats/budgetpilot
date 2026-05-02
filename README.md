# BudgetPilot

Personal financial advisor that connects your bank accounts via Plaid, categorizes every transaction automatically, and gives you AI-powered budget advice via Claude.

## Architecture

```
Browser (Plaid Link + Dashboard)
  ↕
Express Server (Node.js)
  ├── Plaid API → pulls transactions from your banks
  ├── Local JSON file → stores transaction data
  └── Claude API → generates personalized financial insights
```

All data stays on your machine in a local JSON file (`budgetpilot-data.json`). Nothing is sent to external servers except Plaid (for bank connections) and Anthropic (for AI analysis of aggregated spending categories — no raw transaction descriptions are sent).

## Setup

### 1. Get API keys

**Plaid** (free for development):
1. Sign up at [dashboard.plaid.com](https://dashboard.plaid.com)
2. Copy your `client_id` and `sandbox` secret from the Keys page
3. When ready for real bank connections, apply for Production access

**Anthropic** (for AI insights):
1. Get an API key at [console.anthropic.com](https://console.anthropic.com/settings/keys)

### 2. Install & run

```bash
# Clone or download this folder
cd budgetpilot

# Install dependencies
npm install

# Create your .env file
cp .env.example .env
# Edit .env and paste in your API keys

# Start the server
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 3. Connect your banks

1. Click **Connect** in the nav
2. Click the connect card — Plaid Link opens
3. Search for your bank and log in
4. Click **Sync transactions** to pull the last 90 days
5. Go to **Dashboard** to see your spending breakdown

By default the institution picker shows US banks only. To connect banks in other countries, set `PLAID_COUNTRY_CODES` in `.env` to a comma-separated list of ISO codes — e.g. `US,GB,IE,FR`. Plaid currently supports: US, CA, GB, IE, FR, ES, NL, DE, IT, PL, DK, NO, SE, EE, LT, LV, PT, BE.

## Plaid environments

| Environment | Use case | Real banks? |
|-------------|----------|-------------|
| `sandbox` | Testing with fake data | No — uses test credentials |
| `development` | Testing with real banks (100 items free) | Yes |
| `production` | Full production use | Yes — requires Plaid approval |

**To test immediately**: leave `PLAID_ENV=sandbox` and use these test credentials in Plaid Link:
- Username: `user_good`
- Password: `pass_good`

**To connect real accounts**: change to `PLAID_ENV=development`, update `PLAID_SECRET` to your development secret, and link your actual Capital One / Revolut accounts.

## Features

- **Multi-bank dashboard**: all your connected accounts in one view
- **Auto-categorization**: Transactions sorted into 14 spending categories
- **Weekly trend chart**: Visual spending spikes with over-budget flags
- **Recurring merchant tracking**: Identifies habits by frequency + total spend
- **AI advisor**: Claude analyzes your patterns and gives specific budget advice
- **Local storage**: JSON file — your financial data never leaves your machine
- **Transaction browser**: Searchable list across all connected accounts

## Tech stack

- **Backend**: Node.js, Express
- **Bank integration**: Plaid Node SDK
- **AI**: Anthropic Claude API (Sonnet 4.6)
- **Frontend**: Vanilla HTML/CSS/JS, Chart.js, Plaid Link
- **Storage**: Local JSON file (zero deps, no setup)

## License

MIT — see [LICENSE](LICENSE).
