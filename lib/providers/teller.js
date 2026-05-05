// Teller adapter — US bank-data provider via mTLS REST API.
//
// Auth model: every API call carries (a) the access_token as HTTP Basic
// username (no password), and (b) a client certificate negotiated at the TLS
// layer. The cert + key files are issued to the application in the Teller
// dashboard and loaded here from filesystem paths in .env.
//
// Sign convention: Teller returns NEGATIVE for debits (purchases). Our DB
// stores POSITIVE for spend, NEGATIVE for refunds. normalizeTransaction
// flips sign so downstream code (categorization, totals, dedup, AI advisor)
// works unchanged.

const fs = require("fs");
const https = require("https");

const TELLER_HOST = "api.teller.io";

function readCertPair() {
  const certPath = process.env.TELLER_CERT_PATH;
  const keyPath = process.env.TELLER_KEY_PATH;
  if (!certPath || !keyPath) {
    throw new Error("Teller is not configured. Set TELLER_CERT_PATH and TELLER_KEY_PATH in .env, and place the cert/key files at those paths.");
  }
  if (!fs.existsSync(certPath)) throw new Error(`Teller cert not found at ${certPath}`);
  if (!fs.existsSync(keyPath)) throw new Error(`Teller key not found at ${keyPath}`);
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
}

function tellerRequest({ method = "GET", path, accessToken, body = null }) {
  const { cert, key } = readCertPair();
  const auth = Buffer.from(`${accessToken}:`).toString("base64");

  return new Promise((resolve, reject) => {
    const req = https.request({
      method,
      hostname: TELLER_HOST,
      path,
      cert,
      key,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          const err = new Error(`Teller ${method} ${path} → ${res.statusCode}: ${text.slice(0, 300)}`);
          err.status = res.statusCode;
          err.body = parsed;
          reject(err);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// --- Provider interface ------------------------------------------------------

async function initConnect() {
  const applicationId = process.env.TELLER_APPLICATION_ID;
  const environment = process.env.TELLER_ENVIRONMENT || "development";
  if (!applicationId) {
    throw new Error("TELLER_APPLICATION_ID is not set in .env");
  }
  return {
    flowType: "modal",
    payload: { applicationId, environment },
  };
}

async function completeConnect({ callback }) {
  // Teller's frontend Connect widget hands the success payload directly:
  //   callback = { accessToken, enrollment: { id, institution: { name } }, user: {...} }
  if (!callback?.accessToken) {
    throw new Error("Teller completeConnect: callback.accessToken is required");
  }
  const accessToken = callback.accessToken;
  const enrollmentId = callback.enrollment?.id || null;
  const institutionName = callback.enrollment?.institution?.name || "Unknown";

  return {
    provider: "teller",
    status: "active",
    institution_name: institutionName,
    credentials: {
      accessToken,
      enrollmentId,
    },
  };
}

async function listAccounts(connection) {
  const accounts = await tellerRequest({
    path: "/accounts",
    accessToken: connection.credentials.accessToken,
  });
  return (accounts || []).map(a => ({
    providerAccountId: a.id,
    name: a.name,
    type: a.subtype || a.type || "account",
    mask: a.last_four || null,
    currency: a.currency || "USD",
  }));
}

async function fetchTransactions(connection, range) {
  const accessToken = connection.credentials.accessToken;
  // Teller's /accounts call gives us the IDs, then we pull transactions per account.
  const accounts = await tellerRequest({ path: "/accounts", accessToken });
  const all = [];
  for (const acct of accounts || []) {
    const txns = await tellerRequest({
      path: `/accounts/${acct.id}/transactions`,
      accessToken,
    });
    for (const t of txns || []) {
      const normalized = normalizeTransaction(t, acct);
      if (normalized) all.push(normalized);
    }
  }
  return { transactions: all };
}

async function disconnect(connection) {
  // Teller revokes per-account. Best-effort: list accounts, delete each. If the
  // token is already invalid the requests will 401; treat as revoked anyway.
  try {
    const accounts = await tellerRequest({
      path: "/accounts",
      accessToken: connection.credentials.accessToken,
    });
    for (const a of accounts || []) {
      try {
        await tellerRequest({
          method: "DELETE",
          path: `/accounts/${a.id}`,
          accessToken: connection.credentials.accessToken,
        });
      } catch (err) {
        // continue — partial revocation is still progress
        console.error(`Teller disconnect account ${a.id}: ${err.message}`);
      }
    }
    return { revoked: true };
  } catch (err) {
    if (err.status === 401 || err.status === 404) return { revoked: true };
    throw err;
  }
}

// --- Transaction normalization ---------------------------------------------

function normalizeTransaction(t, account) {
  if (!t || !t.id || !t.date) return null;
  // Skip non-posted unless we want pending. Posted-only matches our existing
  // "stable transactions" model; pending transactions can mutate.
  if (t.status && t.status !== "posted") return null;

  const rawAmount = parseFloat(t.amount);
  if (!Number.isFinite(rawAmount)) return null;

  // Teller: negative = debit (spend), positive = credit (refund/income).
  // Our DB convention: positive = spend, negative = refund. Flip sign.
  const flipped = -rawAmount;

  const counterparty = t.details?.counterparty?.name || t.description || "Unknown";

  return {
    id: `teller_${t.id}`,
    providerAccountId: account.id,
    date: t.date,
    amount: Number(flipped.toFixed(2)),
    description: t.description || counterparty,
    merchant: counterparty,
    currency: account.currency || "USD",
    provider_metadata: {
      type: t.type,
      category: t.details?.category,
    },
  };
}

// --- Income / non-spend detection ------------------------------------------
//
// Teller doesn't ship Plaid's personal_finance_category. We rely on:
//  (a) the transaction `type` field for transfers/wires
//  (b) description regex for credit-card payments and payroll/deposit text
// matched against the original (pre-sign-flip) raw transaction.

function isNonSpendCredit(raw) {
  const text = `${raw.description || ""} ${raw.details?.counterparty?.name || ""}`;
  if (/online pymt|online payment|card payment|autopay payment|thank you for your payment|capital one.*(pymt|payment)/i.test(text)) {
    return true;
  }
  if (/payroll|salary|direct deposit|interest earned|tax refund/i.test(text)) {
    return true;
  }
  // Incoming transfers (Teller positive = credit before our flip)
  const rawAmount = parseFloat(raw.amount);
  if (rawAmount > 0 && raw.type && /transfer|wire|ach/i.test(raw.type)) {
    // A pure refund usually has type === "card_payment" with positive amount;
    // a transfer/wire/ACH is typically not a refund.
    return true;
  }
  return false;
}

module.exports = {
  name: "teller",
  initConnect,
  completeConnect,
  listAccounts,
  fetchTransactions,
  disconnect,
  isNonSpendCredit,
  normalizeTransaction,
};
