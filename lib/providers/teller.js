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
//
// Teller's signed-amount convention is per-account:
//   * credit_card accounts: POSITIVE = charge (balance increased = spend),
//                           NEGATIVE = payment-received or refund (balance decreased)
//   * checking/savings:     POSITIVE = deposit (balance increased = income),
//                           NEGATIVE = withdrawal (balance decreased = spend)
//
// Our DB convention is uniform: POSITIVE = spend, NEGATIVE = refund.
// So we flip sign for non-credit-card accounts only.

function isCreditCard(account) {
  const t = (account?.type || "").toLowerCase();
  const s = (account?.subtype || "").toLowerCase();
  return t === "credit_card" || t === "credit card" || s === "credit_card" || s === "credit card" || t.includes("credit");
}

function normalizeTransaction(t, account) {
  if (!t || !t.id || !t.date) return null;
  // Skip non-posted; pending transactions can mutate later.
  if (t.status && t.status !== "posted") return null;

  const rawAmount = parseFloat(t.amount);
  if (!Number.isFinite(rawAmount)) return null;

  const cc = isCreditCard(account);
  const signed = cc ? rawAmount : -rawAmount;
  const counterparty = t.details?.counterparty?.name || t.description || "Unknown";

  const isMovement = isNonSpendMovement(t, account, signed);

  // On a CREDIT CARD account, money coming in (negative `signed` after our
  // sign normalization) is exclusively either:
  //   (a) a payment to the card from another account — already represented on
  //       the source account's side as an outgoing transfer, so skipping here
  //       avoids double-counting in the Transfers view; OR
  //   (b) a refund / chargeback / statement credit — handled below by leaving
  //       it as a normal categorized row with a negative amount (real
  //       spend reduction in the original merchant's category).
  //
  // The non-spend movement detector matches case (a) plus broker/income
  // patterns. We skip those entirely on credit cards instead of tagging them
  // as transfers.
  if (cc && isMovement) return null;

  // On non-credit-card accounts (checking/savings), tag movements as
  // Transfers & Payments so they're visible on the Transfers tab. Sign
  // convention preserved: positive = out, negative = in.
  const transferCategory = (!cc && isMovement) ? "Transfers & Payments" : null;

  return {
    id: `teller_${t.id}`,
    providerAccountId: account.id,
    date: t.date,
    amount: Number(signed.toFixed(2)),
    description: t.description || counterparty,
    merchant: counterparty,
    currency: account.currency || "USD",
    forced_category: transferCategory,
    provider_metadata: {
      type: t.type,
      category: t.details?.category,
    },
  };
}

// True for transactions that are NOT real spending — money movements between
// the user's own accounts and incoming income.
function isNonSpendMovement(t, account, signedAmount) {
  const text = `${t.description || ""} ${t.details?.counterparty?.name || ""}`;
  const cc = isCreditCard(account);

  // ---- Patterns valid on any account ----

  // Direct credit-card payment text — fires on whichever side it appears
  // (e.g. "CAPITAL ONE ONLINE PYMT" on the credit card; "Withdrawal from CAPITAL ONE MOBILE PMT" on checking).
  if (/online pymt|online payment|card payment|autopay payment|thank you for your payment|capital one.*(pymt|payment)|applecard|chase credit|amex epayment|citi.*card.*pmt|discover.*pmt/i.test(text)) {
    return true;
  }

  // Investment broker movements — RSU vesting, dividends, brokerage transfers.
  // Apply on any account type because some users have these route to credit
  // cards (Morgan Stanley → Venture, etc.).
  if (/morgan stanley|fid bkg svc|fidelity|schwab|vanguard|robinhood|moneyline|etrade|e\*trade|ameritrade/i.test(text)) {
    return true;
  }

  // Bank-paid interest on a deposit account — this is income, not spend, and
  // the cents-scale amounts otherwise show up as tiny "refunds" that drag months
  // negative.
  if (/monthly interest paid|interest paid$|interest earned/i.test(text)) {
    return true;
  }

  // Outbound Zelle / Venmo / PayPal transfers to other people. These can be
  // legitimate spend (paying a contractor), but for a budget tracker the safer
  // default is "transfer" — user can override in the Transactions tab if needed.
  if (/zelle money sent|venmo.*sent|paypal.*sent|sent to/i.test(text)) {
    return true;
  }

  // ---- Patterns valid only on non-credit-card accounts ----

  if (!cc) {
    // "Withdrawal from <something>" on a checking account is almost always an
    // outbound transfer, not a direct purchase. Real card purchases on checking
    // come through with descriptions like "Digital Card Purchase - ..." or just
    // the merchant name without the "Withdrawal from" prefix.
    if (/^withdrawal from/i.test(text.trim())) return true;

    // Incoming Zelle / Venmo / PayPal / Wise transfers
    if (/zelle.*(received|from)|venmo.*(received|from)|received from|incoming transfer/i.test(text)) {
      return true;
    }

    // Salary, payroll, employer direct deposit
    if (/payroll|salary|direct deposit|adp |gusto |employer/i.test(text)) {
      return true;
    }

    // Crypto exchanges
    if (/coinbase|binance|kraken|gemini/i.test(text)) {
      return true;
    }
  }

  // (Type-based signals deliberately omitted: Teller tags some cross-border
  // card purchases with type "transfer" or "wire", and we don't want a
  // legitimate retail charge at a foreign merchant to flip to a transfer just
  // because of how the network routed it.)

  return false;
}

// Public hook (kept for backwards compatibility with the sync route's optional
// pre-filter; normalizeTransaction now handles filtering itself).
function isNonSpendCredit(raw) {
  return isNonSpendMovement(raw, { type: "" }, 0);
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
