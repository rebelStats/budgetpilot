// GoCardless Bank Account Data (formerly Nordigen) — STUB.
//
// This adapter is a placeholder so the factory resolves. The real
// implementation will be added when EU users come online.
//
// Lifecycle (for the future implementer):
//   1. Auth: secret_id + secret_key → POST /api/v2/token/new/ → access_token (~24h),
//      refresh_token (~30d). Refresh on demand from refresh_token.
//   2. Pre-connect: GET /api/v2/institutions/?country=PL → list of banks for the
//      country picker; FE picks one and calls initConnect with institution_id.
//   3. initConnect → POST /api/v2/requisitions/ with institution_id + redirect_uri →
//      returns { id, link }. flowType is "redirect"; FE navigates to `link`.
//   4. User authenticates with bank, returns to redirect_uri with `?ref=<requisition_id>`.
//   5. completeConnect → GET /api/v2/requisitions/:id → list of authorized account
//      UUIDs. Store requisition_id + institution_id in connection.credentials.
//      Set connection.expires_at = now + 90 days (PSD2 re-consent rule).
//   6. fetchTransactions → GET /api/v2/accounts/:id/transactions/?date_from=&date_to=
//      Returns booked + pending arrays. Use booked. transactionAmount has signed amount.
//   7. disconnect → DELETE /api/v2/requisitions/:id.
//
// Sign convention: GoCardless returns negative for debits (like Plaid), so flip
// in normalizeTransaction so stored amount is positive=spend.

const { NotImplementedError } = require("./types");

module.exports = {
  name: "gocardless",

  async initConnect() {
    throw new NotImplementedError("gocardless", "initConnect");
  },

  async completeConnect() {
    throw new NotImplementedError("gocardless", "completeConnect");
  },

  async listAccounts() {
    throw new NotImplementedError("gocardless", "listAccounts");
  },

  async fetchTransactions() {
    throw new NotImplementedError("gocardless", "fetchTransactions");
  },

  async disconnect() {
    throw new NotImplementedError("gocardless", "disconnect");
  },

  isNonSpendCredit() {
    return false;
  },
};
