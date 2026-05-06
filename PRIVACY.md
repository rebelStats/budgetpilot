# Privacy Policy

**Last updated:** 2026-05-04

## What MeridianWallet is

MeridianWallet is an open-source personal finance dashboard that runs entirely on a single user's local machine. It connects to bank accounts via Teller (US), parses uploaded statement files (CSV/PDF), categorizes transactions, and surfaces spending insights through a Claude-powered AI advisor. SaltEdge Account Information API is planned for non-US bank connections (60+ countries); the codebase contains a stub adapter pending credentials.

The application is intended for personal use by an individual operator. The operator and the data subject are the same person. There is no public deployment, no shared backend, and no other end users.

## What data MeridianWallet handles

When the operator connects a bank account via Teller, MeridianWallet receives:

- Account metadata (institution name, account name, account type, masked account ID, currency)
- Teller access tokens (used to fetch transactions on subsequent syncs)
- Transactions (date, amount, merchant name, description, type, currency)

A small number of historical accounts and transactions may exist as `plaid_legacy` records — these were imported from a previous Plaid integration and are now read-only. The Plaid SDK has been removed; no new outbound calls are made to Plaid.

When the operator uploads a CSV or PDF statement, MeridianWallet receives the contents of that file and extracts equivalent transaction records.

## Where data is stored

All data is stored exclusively on the operator's local machine in two files:

- `meridianwallet-data.json` — accounts, transactions, merchant cache, manual category overrides, monthly exchange-rate cache.
- `.env` — Teller application ID and Anthropic API credentials. Never committed to source control. A pre-commit hook in `.githooks/` plus a tightened `.gitignore` prevent the file from being staged accidentally.
- `certs/` — Teller mTLS client certificate and key files. Gitignored; never leaves the operator's disk.

Encryption at rest is provided by the operator's OS-level full-disk encryption (FileVault, BitLocker, or LUKS). The application does not apply additional encryption beyond what the filesystem provides.

The application server binds to `localhost` only and is not exposed to any network beyond the operator's machine.

## What is sent to third parties

MeridianWallet makes outbound network requests to exactly three external services, all over HTTPS:

1. **Teller** (`api.teller.io`) — to retrieve transactions from connected US bank accounts. Authentication is mTLS-mutual: every request carries a client certificate plus the per-enrollment access token. Teller's privacy policy: <https://teller.io/about/privacy>.
2. **Anthropic** (`api.anthropic.com`) — for transaction categorization (Claude Haiku) and the AI advisor chat (Claude Opus). Merchant names, transaction amounts, dates, and categories are sent as part of the model context. Account numbers and access tokens are never sent. Anthropic's privacy policy: <https://www.anthropic.com/legal/privacy>.
3. **Frankfurter** (`api.frankfurter.app`) — for European Central Bank exchange rates used to convert non-USD transactions. No personal data is sent; only date ranges and currency codes.

Future provider: **SaltEdge** (`www.saltedge.com`) for non-US bank connections in 60+ countries via Account Information API. Not currently active; will be added once SaltEdge App-id + Secret credentials are configured. SaltEdge's privacy policy: <https://www.saltedge.com/legal/privacy_policy>.

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
- **Per-account deletion:** The application exposes a `DELETE /api/accounts/:id` endpoint that removes a single account, deletes its transactions, and — if no other accounts share its connection — calls the provider's disconnect to revoke the upstream credentials. A `DELETE /api/connections/:id` endpoint does the same at the connection level.
- **Per-transaction deletion:** Individual transactions are not deletable through the UI; the operator can edit `meridianwallet-data.json` directly if needed.
- **Chat history:** Stored in browser `localStorage` under the key `meridianwallet.chat.v1`. The operator can clear it from within the AI Advisor view ("Clear chat") or by clearing browser storage for `localhost`.

## Operator responsibilities

Because MeridianWallet is single-user and locally hosted, the operator is responsible for:

- Securing the device on which the application runs (OS-level authentication, full-disk encryption).
- Keeping the `.env` file private and not committing it to source control (the included `.gitignore` already excludes it).
- Rotating Teller and Anthropic API credentials if the operator believes they may have been exposed.
- Re-issuing Teller mTLS certificates from the Teller dashboard if the cert files are lost or copied.

## Changes to this policy

This policy is reviewed by the operator on each material change to the application. The current version is the file at `PRIVACY.md` in the repository: <https://github.com/rebelStats/MeridianWallet/blob/main/PRIVACY.md>.

## Contact

The operator is the sole point of contact for privacy questions. Issues and questions about the open-source code may be filed at <https://github.com/rebelStats/MeridianWallet/issues>.
