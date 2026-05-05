// plaid_legacy: read-only adapter for connections that were originally created
// via Plaid. New connections cannot be created with this provider — initConnect
// throws. listAccounts and fetchTransactions are no-ops because the historical
// data already lives in the local DB; we keep this adapter so the factory
// resolves and the existing connection rows have a valid `provider` value that
// downstream code can dispatch on without special-casing.

const { NotImplementedError } = require("./types");

module.exports = {
  name: "plaid_legacy",

  async initConnect() {
    throw new Error("Plaid is no longer supported for new connections. Use Teller (US) or GoCardless (EU).");
  },

  async completeConnect() {
    throw new NotImplementedError("plaid_legacy", "completeConnect");
  },

  async listAccounts(connection) {
    // Returning empty here — the existing accounts row already references this
    // connection, so the route layer reads accounts from db.accounts directly.
    return [];
  },

  async fetchTransactions(connection, range) {
    // Historical transactions are already stored. No upstream sync.
    return { transactions: [] };
  },

  async disconnect(connection) {
    // No upstream call — Plaid SDK has been removed. Treat as already revoked.
    // The route layer marks status "disconnected" regardless.
    return { revoked: true };
  },

  isNonSpendCredit() {
    return false;
  },
};
