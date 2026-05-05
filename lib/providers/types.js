// BankProvider interface contract.
//
// Every provider module exports an object with these methods. The factory at
// ./index.js dispatches by name. Adding GoCardless later means filling in
// gocardless.js without touching server.js or other providers.
//
// flowType discriminant in initConnect() is the key abstraction: Teller and
// Plaid use a modal popup; GoCardless uses a full-page redirect to the bank's
// OAuth screen. The frontend branches on flowType, not provider name.

/**
 * @typedef {Object} ConnectInit
 * @property {"modal"|"redirect"} flowType
 * @property {Object} payload  Provider-specific hints for the FE
 *   (e.g. { applicationId, environment } for Teller modal,
 *   or { authorizationUrl } for GoCardless redirect)
 * @property {string} [draftId]  Opaque server-side correlation handle if needed
 */

/**
 * @typedef {Object} CompleteConnectInput
 * @property {string} provider    "teller" | "gocardless"
 * @property {string} [draftId]   The draftId from initConnect (if used)
 * @property {Object} callback    Provider-specific success payload
 *   (Teller: { accessToken, enrollment }, GoCardless: { requisitionRef })
 */

/**
 * @typedef {Object} Connection
 * @property {string} id
 * @property {"teller"|"gocardless"|"plaid_legacy"} provider
 * @property {"active"|"disconnected"|"reconsent_required"} status
 * @property {string} institution_name
 * @property {string} created_at
 * @property {string|null} expires_at
 * @property {Object} credentials  Provider-specific blob
 */

/**
 * @typedef {Object} ProviderAccount
 * @property {string} providerAccountId  Stable upstream account ID
 * @property {string} name
 * @property {string} type        "checking" | "savings" | "credit card" | …
 * @property {string} [mask]      Last 4 digits if available
 * @property {string} [currency]
 */

/**
 * @typedef {Object} NormalizedTxn
 * @property {string} id          Stable provider-prefixed ID
 * @property {string} providerAccountId
 * @property {string} date        YYYY-MM-DD
 * @property {number} amount      POSITIVE = spend; NEGATIVE = refund (provider sign already normalized)
 * @property {string} description
 * @property {string} merchant
 * @property {string} currency
 * @property {Object} [provider_metadata]  Hints for isNonSpendCredit; not stored
 */

/**
 * @typedef {Object} BankProvider
 * @property {string} name
 * @property {(opts: { returnUrl?: string }) => Promise<ConnectInit>} initConnect
 * @property {(input: CompleteConnectInput) => Promise<Connection>} completeConnect
 * @property {(connection: Connection) => Promise<ProviderAccount[]>} listAccounts
 * @property {(connection: Connection, range: { startDate: string, endDate: string }) => Promise<{ transactions: NormalizedTxn[] }>} fetchTransactions
 * @property {(connection: Connection) => Promise<{ revoked: boolean }>} disconnect
 * @property {(raw: any) => boolean} isNonSpendCredit
 */

class NotImplementedError extends Error {
  constructor(provider, method) {
    super(`${provider}.${method} is not implemented yet`);
    this.code = "NOT_IMPLEMENTED";
  }
}

module.exports = { NotImplementedError };
