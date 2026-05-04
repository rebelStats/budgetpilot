# Privacy Policy

**Last updated:** 2026-05-04

## What MeridianWallet is

MeridianWallet is an open-source personal finance dashboard that runs entirely on a single user's local machine. It connects to bank accounts via Plaid, parses uploaded statement files (CSV/PDF), categorizes transactions, and surfaces spending insights through a Claude-powered AI advisor.

The application is intended for personal use by an individual operator. The operator and the data subject are the same person. There is no public deployment, no shared backend, and no other end users.

## What data MeridianWallet handles

When the operator connects a bank account via Plaid, MeridianWallet receives:

- Account metadata (institution name, account name, account type, masked account ID)
- Plaid access tokens (used to fetch transactions on subsequent syncs)
- Transactions (date, amount, merchant name, description, category, currency)

When the operator uploads a CSV or PDF statement, MeridianWallet receives the contents of that file and extracts equivalent transaction records.

## Where data is stored

All data is stored exclusively on the operator's local machine in two files:

- `meridianwallet-data.json` — accounts, transactions, merchant cache, manual category overrides, monthly exchange-rate cache.
- `.env` — Plaid and Anthropic API credentials. Never committed to source control.

Encryption at rest is provided by the operator's OS-level full-disk encryption (FileVault, BitLocker, or LUKS). The application does not apply additional encryption beyond what the filesystem provides.

The application server binds to `localhost` only and is not exposed to any network beyond the operator's machine.

## What is sent to third parties

MeridianWallet makes outbound network requests to exactly three external services, all over HTTPS:

1. **Plaid** (`api.plaid.com`) — to retrieve transactions from connected bank accounts. Plaid's privacy policy: <https://plaid.com/legal/>.
2. **Anthropic** (`api.anthropic.com`) — for transaction categorization (Claude Haiku) and the AI advisor chat (Claude Opus). Merchant names, transaction amounts, dates, and categories are sent as part of the model context. Account numbers and access tokens are never sent. Anthropic's privacy policy: <https://www.anthropic.com/legal/privacy>.
3. **Frankfurter** (`api.frankfurter.app`) — for European Central Bank exchange rates used to convert non-USD transactions. No personal data is sent; only date ranges and currency codes.

## What MeridianWallet does NOT do

- No analytics, telemetry, crash reporting, or usage tracking.
- No advertising or ad-network integrations.
- No data sharing with parties beyond the three services listed above.
- No automatic backups, replication, or syncing to any cloud storage.
- No collection of personal information beyond what the operator's bank or uploaded statements contain.
- No identity verification, biometric data, or device fingerprinting.

## Retention and deletion

- **Retention:** Indefinite by default and entirely under the operator's control.
- **Local deletion:** The operator can delete `meridianwallet-data.json` at any time. This removes all transactions, accounts, access tokens, merchant cache, category overrides, and chat history.
- **Per-account deletion:** The application exposes a `DELETE /api/accounts/:id` endpoint that removes a single account, deletes its transactions, and — if no other accounts share its Plaid Item — calls Plaid's `/item/remove` to revoke the upstream connection.
- **Per-transaction deletion:** Individual transactions are not deletable through the UI; the operator can edit `meridianwallet-data.json` directly if needed.
- **Chat history:** Stored in browser `localStorage` under the key `meridianwallet.chat.v1`. The operator can clear it from within the AI Advisor view ("Clear chat") or by clearing browser storage for `localhost`.

## Operator responsibilities

Because MeridianWallet is single-user and locally hosted, the operator is responsible for:

- Securing the device on which the application runs (OS-level authentication, full-disk encryption).
- Keeping the `.env` file private and not committing it to source control (the included `.gitignore` already excludes it).
- Rotating Plaid and Anthropic API credentials if the operator believes they may have been exposed.

## Changes to this policy

This policy is reviewed by the operator on each material change to the application. The current version is the file at `PRIVACY.md` in the repository: <https://github.com/rebelStats/MeridianWallet/blob/main/PRIVACY.md>.

## Contact

The operator is the sole point of contact for privacy questions. Issues and questions about the open-source code may be filed at <https://github.com/rebelStats/MeridianWallet/issues>.
