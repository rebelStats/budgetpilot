// JSON file storage. Single-user local app — one DB file, full read/write on
// every change. The schema is provider-agnostic: connections own credentials,
// accounts reference connections, transactions reference accounts.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = path.join(__dirname, "..", "meridianwallet-data.json");
const LEGACY_DB_PATH = path.join(__dirname, "..", "budgetpilot-data.json");

// One-time filename migration: budgetpilot-data.json → meridianwallet-data.json.
// Kept here from the earlier rename so loadDB stays the single entry point.
function migrateDbFilename() {
  if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
    fs.renameSync(LEGACY_DB_PATH, DB_PATH);
    console.log(`  Migrated data file: budgetpilot-data.json → meridianwallet-data.json`);
  }
}

function loadDB() {
  migrateDbFilename();
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      // Default-fill any keys added since the file was last written so older
      // databases keep working after upgrades.
      if (!data.accounts) data.accounts = [];
      if (!data.transactions) data.transactions = [];
      if (!data.connections) data.connections = [];
      if (!data.merchantCache) data.merchantCache = {};
      if (!data.merchantOverrides) data.merchantOverrides = {};
      if (!data.exchangeRatesByMonth) data.exchangeRatesByMonth = {};
      migrateAccountsToConnections(data);
      return data;
    }
  } catch (err) {
    console.error("loadDB error:", err.message);
  }
  return {
    accounts: [],
    transactions: [],
    connections: [],
    merchantCache: {},
    merchantOverrides: {},
    exchangeRatesByMonth: {},
  };
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Idempotent: convert any account record carrying a Plaid-style `access_token`
// into a `plaid_legacy` connection + slim account row. Called from loadDB on
// every startup; safe because once accounts no longer have `access_token` the
// loop is a no-op.
function migrateAccountsToConnections(data) {
  const orphans = data.accounts.filter(a => a.access_token && !a.connection_id);
  if (!orphans.length) return;

  // Group orphans by access_token — one Plaid Item can cover multiple accounts,
  // and we want each Item to become a single connection row.
  const byToken = new Map();
  for (const a of orphans) {
    if (!byToken.has(a.access_token)) byToken.set(a.access_token, []);
    byToken.get(a.access_token).push(a);
  }

  for (const [access_token, accts] of byToken) {
    const first = accts[0];
    const connectionId = "conn_" + crypto.randomBytes(8).toString("hex");
    data.connections.push({
      id: connectionId,
      provider: "plaid_legacy",
      status: "disconnected",
      institution_name: first.institution_name || "Unknown",
      created_at: new Date().toISOString(),
      expires_at: null,
      credentials: {
        access_token,
        item_id: first.item_id || null,
      },
    });

    for (const a of accts) {
      a.connection_id = connectionId;
      a.provider_account_id = a.id; // preserve original Plaid account_id mapping
      delete a.access_token;
      delete a.item_id;
    }
  }

  console.log(`  Schema migration: created ${byToken.size} plaid_legacy connection${byToken.size === 1 ? "" : "s"} from ${orphans.length} legacy account row${orphans.length === 1 ? "" : "s"}`);
  saveDB(data);
}

module.exports = { loadDB, saveDB, DB_PATH };
