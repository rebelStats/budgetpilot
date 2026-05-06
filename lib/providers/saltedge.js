// SaltEdge Account Information API — STUB.
//
// SaltEdge is the chosen provider for non-US bank connections. It supports
// 60+ countries (full list embedded in the FE country picker). The real
// implementation will be added when SaltEdge credentials are configured.
//
// Lifecycle (for the future implementer):
//   1. Auth: SaltEdge App-id + Secret pair in headers on every request
//      (no per-user token). Requests go to https://www.saltedge.com.
//   2. Pre-connect: POST /api/v6/connect_sessions/create with
//      { customer_id, attempt: { return_to: <our callback url>,
//        fetch_scopes: ["accounts","transactions"] } } returns { connect_url }.
//   3. initConnect → returns flowType "redirect" with payload.authorizationUrl
//      = connect_url. FE navigates the user there.
//   4. SaltEdge's hosted widget walks the user through country/bank choice
//      and authentication; on success redirects back to our return_to URL
//      with `?connection_id=...&customer_id=...`.
//   5. completeConnect → store { connectionId, customerId } in connection.credentials.
//      Set connection.expires_at based on the SaltEdge `consent.expires_at` field
//      (typically 90-180 days, varies by provider/country).
//   6. listAccounts → GET /api/v6/accounts?connection_id=:id
//      Returns array with id, name, currency_code, balance, extra.account_type,
//      and other metadata.
//   7. fetchTransactions → GET /api/v6/transactions?account_id=:id with
//      pagination. SaltEdge txn shape: { id, made_on, amount (signed),
//      currency_code, description, category, mode (normal/transfer/fee),
//      status (posted/pending), extra: {...} }.
//   8. disconnect → DELETE /api/v6/connections/:id.
//
// Sign convention: SaltEdge returns negative for debits (consistent with
// most aggregators). For credit cards we'd flip sign similarly to Teller's
// per-account-type rule.
//
// Customer model: SaltEdge requires a `customer_id` per end-user. For the
// single-user app, create one customer up-front via POST /api/v6/customers
// and reuse its id across all connections; for multi-tenant the customer_id
// would be created per signup.

const { NotImplementedError } = require("./types");

module.exports = {
  name: "saltedge",

  async initConnect() {
    throw new NotImplementedError("saltedge", "initConnect");
  },

  async completeConnect() {
    throw new NotImplementedError("saltedge", "completeConnect");
  },

  async listAccounts() {
    throw new NotImplementedError("saltedge", "listAccounts");
  },

  async fetchTransactions() {
    throw new NotImplementedError("saltedge", "fetchTransactions");
  },

  async disconnect() {
    throw new NotImplementedError("saltedge", "disconnect");
  },

  isNonSpendCredit() {
    return false;
  },
};
