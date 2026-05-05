require("dotenv").config({ override: true });
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// JSON file storage — extracted to lib/db.js, including the connection schema
// migration (legacy accounts with access_tokens become plaid_legacy connections).
// ---------------------------------------------------------------------------
const { loadDB, saveDB, DB_PATH } = require("./lib/db");
const { getProvider, listProviders } = require("./lib/providers");

// ---------------------------------------------------------------------------
// Category mapping: regex fast path → AI classifier (cached) → "Other"
// ---------------------------------------------------------------------------
const CATEGORIES = [
  "Currency Exchange", "Cash & ATM", "Taxes & Government", "Groceries",
  "Dining & Restaurants", "Transport & Rides", "Flights & Travel", "Medical & Pharmacy",
  "Shopping & Online", "Subscriptions & Digital", "Home & Furniture", "Entertainment",
  "Clothing & Fashion", "Personal Care", "Utilities & Bills", "Transfers & Payments", "Other"
];

// Categories that represent money-movement, not discretionary spending.
// Currency Exchange is fully excluded from spend totals.
const EXCLUDED_FROM_SPEND = new Set(["Currency Exchange"]);

function categorize(plaidCategories, merchantName, cache, description, overrides) {
  // Manual user override always wins.
  const override = overrides?.[merchantName];
  if (override && CATEGORIES.includes(override)) return override;
  // Run regex against description+merchant combined — patterns like
  // "Transfer to <PERSON>" only match the full description, not the cleaned merchant.
  const searchText = description ? `${description} ${merchantName || ""}`.trim() : (merchantName || "");
  const regex = mapCategory(plaidCategories, searchText);
  if (regex !== "Other") return regex;
  const cached = cache?.[merchantName];
  if (cached && CATEGORIES.includes(cached)) return cached;
  return "Other";
}

function isClassifiableMerchant(m) {
  if (!m) return false;
  // Skip garbled/redacted merchant names like "*****" or "***.****"
  if (/^[*\s_.\-]+$/.test(m)) return false;
  return true;
}

async function classifyMerchantsWithAI(merchants) {
  if (!merchants.length || !process.env.ANTHROPIC_API_KEY) return {};

  const prompt = `Classify each merchant name into ONE of these spending categories:
${CATEGORIES.join(", ")}

Important rules:
- "Transfers & Payments" is ONLY for person-to-person money transfers (e.g. "Transfer to John Smith", "Send to Mom"). Payment processors and gateways like Blue Media, Vimpay, Stripe, PayPal, etc. are NOT transfers — classify by what the user actually bought (or "Other" if unclear).
- "Currency Exchange" is ONLY for explicit FX conversions between own wallets (e.g. "Exchanged to HUF").
- "Cash & ATM" is for ATM withdrawals and cash advances.
- Use "Other" when truly unclear. Do not invent new categories.

Return ONLY a JSON object mapping merchant → category.

Merchants:
${JSON.stringify(merchants)}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }
  const text = data.content?.[0]?.text || "";
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());

  const valid = {};
  for (const [m, cat] of Object.entries(parsed)) {
    valid[m] = CATEGORIES.includes(cat) ? cat : "Other";
  }
  return valid;
}

async function classifyUnknownMerchants(db) {
  const unknown = new Set();
  db.transactions.forEach(t => {
    if (t.category !== "Other") return;
    const m = t.merchant || t.description;
    if (!isClassifiableMerchant(m)) return;
    if (db.merchantCache[m]) return;
    unknown.add(m);
  });

  if (!unknown.size) return { classified: 0 };

  const merchants = [...unknown];
  let classified = 0;
  for (let i = 0; i < merchants.length; i += 50) {
    const batch = merchants.slice(i, i + 50);
    try {
      const results = await classifyMerchantsWithAI(batch);
      Object.assign(db.merchantCache, results);
      classified += Object.keys(results).length;
    } catch (err) {
      console.error("AI classification batch failed:", err.message);
    }
  }

  db.transactions.forEach(t => {
    if (t.category !== "Other") return;
    const m = t.merchant || t.description;
    if (db.merchantCache[m]) t.category = db.merchantCache[m];
  });

  return { classified };
}

function mapCategory(plaidCategories, merchantName) {
  const cats = (plaidCategories || []).join(" ").toLowerCase();
  const m = (merchantName || "").toLowerCase();

  if (/exchange|currency conversion|fx (gain|loss|fee)/i.test(cats) || /^exchanged? (to|from)\b|\bcurrency conversion\b|^fx /i.test(m)) return "Currency Exchange";
  if (/atm|cash advance|cash withdrawal/i.test(cats) || /^cash withdraw|^withdrawal at|\batm\b|cash advance/i.test(m)) return "Cash & ATM";
  if (/^transfer (to|from)\s/i.test(m)) return "Transfers & Payments";
  if (/government|tax authority/i.test(cats) || /e-pit|skarbowy|urząd|us skarbowy/i.test(m)) return "Taxes & Government";
  if (/groceries|supermarket/i.test(cats) || /spar|lidl|carrefour|frisco|zabka|biedronka|tesco|piekarnia|crazy butcher/i.test(m)) return "Groceries";
  if (/restaurant|dining|food and drink|cafe|coffee/i.test(cats) || /wolt|bolt food|kantin|kantyna|étterem|restauracja|kawiarnia|ramen|pizza|burger|sushi|wafu|frici|monokini|tarka macska|byc moze|być może|modszertani kabinet/i.test(m)) return "Dining & Restaurants";
  if (/taxi|ride share|uber|lyft|bolt|transportation/i.test(cats) || /uber|bolt\.eu|taxi|budapestgo|simplep\*budapestgo|simplep\*vimpay|\bvimpay\b/i.test(m)) return "Transport & Rides";
  if (/airlines|travel|hotel|lodging/i.test(cats) || /wizz|getyourguide|booking\.com|airbnb|ryanair|lot polish/i.test(m)) return "Flights & Travel";
  if (/pharmacy|health|medical|doctor|dentist/i.test(cats) || /taban medical|patika|apteka|medis|aurismed|lafit/i.test(m)) return "Medical & Pharmacy";
  if (/shops|shopping|online|amazon|ebay/i.test(cats) || /amazon|ebay|allegro|ikea|g2a\.com|moka united|shopinext|\*+\.\*+/i.test(m)) return "Shopping & Online";
  if (/subscription|digital|streaming|software/i.test(cats) || /apple\.com|google \*|google one|imdbpro|audible|netflix|spotify|claude\.ai|openai|chatgpt|github|anthropic|metal plan fee|premium plan fee|standard plan fee|revolut plan/i.test(m)) return "Subscriptions & Digital";
  if (/home|furniture|hardware/i.test(cats)) return "Home & Furniture";
  if (/entertainment|recreation|gaming/i.test(cats) || /getcracked|exponent member/i.test(m)) return "Entertainment";
  if (/clothing|apparel/i.test(cats) || /new yorker|reserved|dior|rossmann|intimi/i.test(m)) return "Clothing & Fashion";
  if (/personal care|beauty|barber|salon/i.test(cats) || /barber|salon|fryzjer/i.test(m)) return "Personal Care";
  if (/utilities|telecom|phone|internet|bills/i.test(cats) || /telekom|orange|t-mobile|play|plus gsm|^fi\s|google fi|\bblue media\b/i.test(m)) return "Utilities & Bills";
  if (/transfer|payment|bank/i.test(cats)) return "Transfers & Payments";
  return "Other";
}

// True when an EXISTING stored transaction looks like a credit-card payment
// rather than a real refund. Used by the cleanup endpoint and the startup
// sweep to retroactively remove these from the local DB.
function isStoredCreditCardPayment(t) {
  if (t.amount >= 0) return false;
  const text = `${t.description || ""} ${t.merchant || ""}`;
  return /online pymt|online payment|card payment|autopay payment|thank you for your payment|capital one.*(pymt|payment)/i.test(text);
}

// ---------------------------------------------------------------------------
// Routes: Connections (provider-agnostic)
//   Dispatches to the provider module (Teller for new connections;
//   gocardless future). Plaid was the previous provider; historical
//   plaid_legacy connections remain readable but cannot be re-synced.
// ---------------------------------------------------------------------------

app.post("/api/connect/init", async (req, res) => {
  try {
    const { provider } = req.body || {};
    if (!provider) return res.status(400).json({ error: "provider required" });
    if (provider === "plaid_legacy") {
      return res.status(400).json({ error: "Plaid is no longer supported for new connections." });
    }
    const adapter = getProvider(provider);
    const init = await adapter.initConnect({ returnUrl: req.body?.returnUrl });
    res.json({ provider, ...init });
  } catch (err) {
    console.error("connect/init error:", err.message);
    res.status(500).json({ error: err.message || "Failed to initialize connect" });
  }
});

app.post("/api/connect/complete", async (req, res) => {
  try {
    const { provider, draftId, callback } = req.body || {};
    if (!provider) return res.status(400).json({ error: "provider required" });
    const adapter = getProvider(provider);
    const partial = await adapter.completeConnect({ provider, draftId, callback });

    const db = loadDB();
    const connectionId = "conn_" + crypto.randomBytes(8).toString("hex");
    const connection = {
      id: connectionId,
      provider: partial.provider,
      status: partial.status || "active",
      institution_name: partial.institution_name,
      created_at: new Date().toISOString(),
      expires_at: partial.expires_at || null,
      credentials: partial.credentials,
    };
    db.connections.push(connection);

    // Discover accounts under this new connection and store them.
    const providerAccounts = await adapter.listAccounts(connection);
    const newAccounts = providerAccounts.map(pa => ({
      id: "acct_" + crypto.randomBytes(8).toString("hex"),
      connection_id: connectionId,
      provider_account_id: pa.providerAccountId,
      institution_name: connection.institution_name,
      account_name: pa.name,
      account_type: pa.type,
      currency: pa.currency || "USD",
      mask: pa.mask || null,
    }));
    db.accounts.push(...newAccounts);
    saveDB(db);

    // Strip credentials from response.
    const { credentials, ...safeConn } = connection;
    res.json({
      connection: safeConn,
      accounts: newAccounts.map(({ id, account_name, account_type, mask, currency }) =>
        ({ id, account_name, account_type, mask, currency })),
    });
  } catch (err) {
    console.error("connect/complete error:", err.message);
    res.status(500).json({ error: err.message || "Failed to complete connect" });
  }
});

app.get("/api/connect/callback", (req, res) => {
  // Route shell for future redirect-flow providers (e.g. GoCardless). Frontend
  // will call /api/connect/complete after this lands and finalize the connection.
  res.status(501).json({ error: "Redirect-flow providers not yet wired" });
});

app.get("/api/connections", (req, res) => {
  const db = loadDB();
  // Strip credentials before responding.
  const safe = db.connections.map(({ credentials, ...rest }) => rest);
  res.json(safe);
});

app.delete("/api/connections/:id", async (req, res) => {
  try {
    const db = loadDB();
    const connection = db.connections.find(c => c.id === req.params.id);
    if (!connection) return res.status(404).json({ error: "Connection not found" });

    let revoked = false;
    try {
      const adapter = getProvider(connection.provider);
      const result = await adapter.disconnect(connection);
      revoked = !!result?.revoked;
    } catch (err) {
      console.error(`Provider disconnect (${connection.provider}) failed: ${err.message}`);
      // Continue with local cleanup even if upstream disconnect fails.
    }

    const accountIds = db.accounts.filter(a => a.connection_id === connection.id).map(a => a.id);
    const removedTxns = db.transactions.filter(t => accountIds.includes(t.account_id)).length;
    db.transactions = db.transactions.filter(t => !accountIds.includes(t.account_id));
    db.accounts = db.accounts.filter(a => a.connection_id !== connection.id);
    db.connections = db.connections.filter(c => c.id !== connection.id);
    saveDB(db);
    res.json({ removed: connection.id, revoked, removedTxns, removedAccounts: accountIds.length });
  } catch (err) {
    console.error("DELETE /api/connections error:", err.message);
    res.status(500).json({ error: "Failed to remove connection" });
  }
});

app.post("/api/sync", async (req, res) => {
  try {
    const db = loadDB();
    const targetId = req.body?.connectionId;
    const targets = targetId
      ? db.connections.filter(c => c.id === targetId)
      : db.connections.filter(c => c.status === "active" && c.provider !== "plaid_legacy");

    if (!targets.length) {
      return res.json({ added: 0, perConnection: [], note: "No active non-legacy connections to sync" });
    }

    const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = new Date().toISOString().slice(0, 10);
    const existingIds = new Set(db.transactions.map(t => t.id));
    const perConnection = [];

    // Recategorize existing transactions so categorizer fixes apply without forcing a wipe.
    db.transactions.forEach(t => {
      t.category = categorize([], t.merchant, db.merchantCache, t.description, db.merchantOverrides);
    });

    let totalAdded = 0;
    for (const connection of targets) {
      const adapter = getProvider(connection.provider);
      let added = 0;
      let skippedNonSpend = 0;
      let skippedDup = 0;
      try {
        const { transactions } = await adapter.fetchTransactions(connection, { startDate, endDate });
        for (const t of transactions) {
          if (existingIds.has(t.id)) continue;
          // adapter-specific income/transfer/CC-payment filter (works on raw shape)
          if (t.provider_metadata && adapter.isNonSpendCredit?.({
            description: t.description,
            details: { counterparty: { name: t.merchant }, category: t.provider_metadata.category },
            type: t.provider_metadata.type,
            amount: String(-t.amount), // pass pre-flip sign for the heuristic
          })) {
            skippedNonSpend++;
            continue;
          }
          // Cross-source dedup against existing transactions
          const dupProbe = { date: t.date, amount: t.amount, merchant: t.merchant, description: t.description };
          if (findCrossSourceDuplicate(dupProbe, db.transactions)) { skippedDup++; continue; }

          // Map providerAccountId → our internal account.id
          const acct = db.accounts.find(a =>
            a.connection_id === connection.id && a.provider_account_id === t.providerAccountId);
          if (!acct) {
            console.error(`Sync: no account row for ${connection.provider} providerAccountId=${t.providerAccountId} on connection ${connection.id}`);
            continue;
          }

          db.transactions.push({
            id: t.id,
            account_id: acct.id,
            date: t.date,
            description: t.description,
            amount: t.amount,
            category: categorize([], t.merchant, db.merchantCache, t.description, db.merchantOverrides),
            merchant: t.merchant,
            source: connection.institution_name,
            currency: t.currency || "USD",
          });
          existingIds.add(t.id);
          added++;
        }
      } catch (err) {
        console.error(`Sync ${connection.provider} (${connection.id}) failed: ${err.message}`);
        perConnection.push({ connectionId: connection.id, provider: connection.provider, error: err.message });
        continue;
      }
      perConnection.push({ connectionId: connection.id, provider: connection.provider, added, skippedNonSpend, skippedDup });
      totalAdded += added;
    }

    db.transactions.sort((a, b) => b.date.localeCompare(a.date));

    // AI classification on any newly-unknown merchants.
    const aiResult = await classifyUnknownMerchants(db);

    saveDB(db);
    res.json({ added: totalAdded, perConnection, aiClassified: aiResult.classified, total: db.transactions.length });
  } catch (err) {
    console.error("/api/sync error:", err.message);
    res.status(500).json({ error: "Failed to sync" });
  }
});

// ---------------------------------------------------------------------------
// Routes: Data queries
// ---------------------------------------------------------------------------

app.get("/api/accounts", (req, res) => {
  const db = loadDB();
  res.json(db.accounts.map(({ access_token, ...rest }) => rest));
});

app.patch("/api/transactions/:id", (req, res) => {
  try {
    const { description, applyToAll } = req.body;
    if (typeof description !== "string") {
      return res.status(400).json({ error: "description string required" });
    }
    const trimmed = description.trim().slice(0, 200);
    if (!trimmed) return res.status(400).json({ error: "description cannot be empty" });

    const db = loadDB();
    const t = db.transactions.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: "transaction not found" });

    const oldDesc = t.description;
    const oldMerchant = t.merchant;

    let updated = 0;
    const oldMerchantsTouched = new Set();
    if (applyToAll) {
      db.transactions.forEach(x => {
        if (x.description !== oldDesc) return;
        if (x.merchant) oldMerchantsTouched.add(x.merchant);
        x.description = trimmed;
        x.merchant = trimmed;
        updated++;
      });
    } else {
      if (t.merchant) oldMerchantsTouched.add(t.merchant);
      t.description = trimmed;
      t.merchant = trimmed;
      updated = 1;
    }
    // Migrate per-merchant override / AI-cache entries to the new merchant key
    // for every old merchant we just orphaned.
    oldMerchantsTouched.forEach(om => {
      if (om === trimmed) return;
      const stillUsed = db.transactions.some(x => x.merchant === om);
      if (stillUsed) return;
      if (db.merchantOverrides[om]) {
        db.merchantOverrides[trimmed] = db.merchantOverrides[om];
        delete db.merchantOverrides[om];
      }
      if (db.merchantCache[om]) {
        db.merchantCache[trimmed] = db.merchantCache[om];
        delete db.merchantCache[om];
      }
    });
    saveDB(db);
    res.json({ id: t.id, description: trimmed, merchant: t.merchant, updated });
  } catch (err) {
    console.error("Description edit error:", err);
    res.status(500).json({ error: "Failed to update description" });
  }
});

app.get("/api/categories", (req, res) => {
  const db = loadDB();
  res.json({ categories: CATEGORIES, overrides: db.merchantOverrides });
});

app.post("/api/overrides", (req, res) => {
  try {
    const { merchant, category } = req.body;
    if (!merchant || typeof merchant !== "string") {
      return res.status(400).json({ error: "merchant required" });
    }

    const db = loadDB();
    let updated = 0;

    if (!category || category === "Auto" || category === null) {
      // Clear the override and let categorize() fall back to regex/cache.
      delete db.merchantOverrides[merchant];
      db.transactions.forEach(t => {
        if (t.merchant !== merchant) return;
        const fresh = categorize([], t.merchant, db.merchantCache, t.description, db.merchantOverrides);
        if (fresh !== t.category) { t.category = fresh; updated++; }
      });
      saveDB(db);
      return res.json({ cleared: true, merchant, updated });
    }

    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `Unknown category: ${category}` });
    }
    db.merchantOverrides[merchant] = category;
    db.transactions.forEach(t => {
      if (t.merchant !== merchant) return;
      if (t.category !== category) { t.category = category; updated++; }
    });
    saveDB(db);
    res.json({ merchant, category, updated });
  } catch (err) {
    console.error("Override error:", err);
    res.status(500).json({ error: "Failed to update override" });
  }
});

app.post("/api/cleanup-credit-card-payments", (req, res) => {
  try {
    const db = loadDB();
    const before = db.transactions.length;
    const removed = db.transactions.filter(isStoredCreditCardPayment);
    db.transactions = db.transactions.filter(t => !isStoredCreditCardPayment(t));
    saveDB(db);
    res.json({
      removed: removed.length,
      total: before,
      remaining: db.transactions.length,
      sample: removed.slice(0, 5).map(t => ({ date: t.date, merchant: t.merchant, amount: t.amount })),
    });
  } catch (err) {
    console.error("Cleanup error:", err);
    res.status(500).json({ error: "Cleanup failed" });
  }
});

app.post("/api/recategorize", async (req, res) => {
  try {
    const db = loadDB();
    // Drop AI cache entries the regex would now claim, so they re-flow through the
    // fast path. This catches the case where a stale "Transfers & Payments" cache
    // hit hides a now-stricter Transfers-only definition.
    let purged = 0;
    for (const m of Object.keys(db.merchantCache)) {
      const fresh = mapCategory([], m);
      if (fresh !== "Other") { delete db.merchantCache[m]; purged++; continue; }
      // Also drop misclassified processor names that are stuck on transfers/payments
      if (db.merchantCache[m] === "Transfers & Payments" && !/^transfer (to|from)\s/i.test(m)) {
        delete db.merchantCache[m];
        purged++;
      }
    }
    db.transactions.forEach(t => {
      t.category = categorize([], t.merchant, db.merchantCache, t.description, db.merchantOverrides);
    });
    const aiResult = await classifyUnknownMerchants(db);
    saveDB(db);
    const stillOther = db.transactions.filter(t => t.category === "Other").length;
    res.json({ total: db.transactions.length, purgedCache: purged, aiClassified: aiResult.classified, stillOther });
  } catch (err) {
    console.error("Recategorize error:", err.message);
    res.status(500).json({ error: "Failed to recategorize" });
  }
});

app.delete("/api/accounts/:id", async (req, res) => {
  try {
    const db = loadDB();
    const target = db.accounts.find(a => a.id === req.params.id);
    if (!target) return res.status(404).json({ error: "Account not found" });

    const removedTxns = db.transactions.filter(t => t.account_id === target.id).length;
    db.transactions = db.transactions.filter(t => t.account_id !== target.id);
    db.accounts = db.accounts.filter(a => a.id !== target.id);

    // If this was the last account on its connection, also drop the connection
    // and call the provider's disconnect to revoke upstream credentials.
    let itemRevoked = false;
    const connection = db.connections.find(c => c.id === target.connection_id);
    if (connection) {
      const remainingOnConnection = db.accounts.some(a => a.connection_id === connection.id);
      if (!remainingOnConnection) {
        try {
          const adapter = getProvider(connection.provider);
          const result = await adapter.disconnect(connection);
          itemRevoked = !!result?.revoked;
        } catch (err) {
          console.error(`Provider disconnect (${connection.provider}) failed: ${err.message}`);
        }
        db.connections = db.connections.filter(c => c.id !== connection.id);
      }
    }

    saveDB(db);
    res.json({ removed: target.id, removedTxns, itemRevoked });
  } catch (err) {
    console.error("Delete account error:", err.message);
    res.status(500).json({ error: "Failed to remove account" });
  }
});

app.get("/api/transactions", (req, res) => {
  const { days = 90, category, source } = req.query;
  const db = loadDB();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let txns = db.transactions.filter(t => t.date >= cutoff);
  if (category) txns = txns.filter(t => t.category === category);
  if (source) txns = txns.filter(t => t.source === source);

  res.json(txns.slice(0, 1000));
});

app.get("/api/summary", (req, res) => {
  const { days = 90 } = req.query;
  const db = loadDB();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const allInWindow = db.transactions.filter(t => t.date >= cutoff);

  // Money movement (FX, cash, transfers) — broken out for the dashboard widget.
  const movement = { exchanged: 0, cashAtm: 0, transfers: 0, exchangeCount: 0, cashCount: 0, transferCount: 0 };
  allInWindow.forEach(t => {
    if (t.category === "Currency Exchange") { movement.exchanged += t.amount; movement.exchangeCount++; }
    else if (t.category === "Cash & ATM") { movement.cashAtm += t.amount; movement.cashCount++; }
    else if (t.category === "Transfers & Payments") { movement.transfers += t.amount; movement.transferCount++; }
  });

  // Spend-relevant transactions: drop excluded categories so they never bias the totals.
  const txns = allInWindow.filter(t => !EXCLUDED_FROM_SPEND.has(t.category));

  const total = txns.reduce((s, t) => s + t.amount, 0);

  const catMap = {};
  txns.forEach(t => {
    if (!catMap[t.category]) catMap[t.category] = { category: t.category, total: 0, count: 0 };
    catMap[t.category].total += t.amount;
    catMap[t.category].count++;
  });

  const weekMap = {};
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  txns.forEach(t => {
    const d = new Date(t.date);
    const dayOfWeek = (d.getDay() + 6) % 7; // 0 = Monday
    const monday = new Date(d);
    monday.setDate(d.getDate() - dayOfWeek);
    const sortKey = monday.toISOString().slice(0, 10);
    const label = `${MONTHS[monday.getMonth()]} ${monday.getDate()}`;
    if (!weekMap[sortKey]) weekMap[sortKey] = { label, total: 0 };
    weekMap[sortKey].total += t.amount;
  });

  const srcMap = {};
  txns.forEach(t => {
    if (!srcMap[t.source]) srcMap[t.source] = { source: t.source, total: 0, count: 0 };
    srcMap[t.source].total += t.amount;
    srcMap[t.source].count++;
  });

  const merchMap = {};
  txns.forEach(t => {
    const m = t.merchant || t.description;
    if (!m) return;
    if (!merchMap[m]) merchMap[m] = { merchant: m, total: 0, count: 0 };
    merchMap[m].total += t.amount;
    merchMap[m].count++;
  });

  const months = new Set(txns.map(t => t.date.slice(0, 7)));

  res.json({
    total,
    count: txns.length,
    monthlyAvg: months.size > 0 ? total / months.size : 0,
    byCategory: Object.values(catMap).sort((a, b) => b.total - a.total),
    byWeek: Object.entries(weekMap).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({ week: v.label, weekStart: k, total: v.total })),
    bySource: Object.values(srcMap).sort((a, b) => b.total - a.total),
    topMerchants: Object.values(merchMap).filter(m => m.count >= 2).sort((a, b) => b.total - a.total).slice(0, 15),
    moneyMovement: movement,
  });
});

// ---------------------------------------------------------------------------
// Routes: AI Insights
// ---------------------------------------------------------------------------
app.post("/api/insights", async (req, res) => {
  try {
    const db = loadDB();
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const txns = db.transactions.filter(t => t.date >= cutoff && !EXCLUDED_FROM_SPEND.has(t.category));

    const catMap = {};
    txns.forEach(t => { catMap[t.category] = (catMap[t.category] || 0) + t.amount; });

    const merchMap = {};
    const merchCount = {};
    txns.forEach(t => {
      const m = t.merchant || t.description;
      merchMap[m] = (merchMap[m] || 0) + t.amount;
      merchCount[m] = (merchCount[m] || 0) + 1;
    });

    const total = txns.reduce((s, t) => s + t.amount, 0);
    const months = new Set(txns.map(t => t.date.slice(0, 7))).size || 1;
    const cats = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
    const merchants = Object.entries(merchMap).filter(([m]) => merchCount[m] >= 2).sort((a, b) => b[1] - a[1]).slice(0, 20);

    const prompt = `You are a sharp personal financial advisor. Analyze this spending data and give specific, actionable advice.

Total spent: $${total.toFixed(0)} over ${months} months ($${(total / months).toFixed(0)}/month)

Categories: ${cats.map(([c, v]) => `${c}: $${v.toFixed(0)}`).join(", ")}

Top recurring merchants: ${merchants.map(([m, v]) => `${m}: $${v.toFixed(0)} (${merchCount[m]}x)`).join(", ")}

Respond ONLY in JSON: {"cut":"...","savings":"$X/month","sneaky":"...","positive":"...","budget":"...","monthlyTarget":number,"weekPlan":["week 1: ...","week 2: ...","week 3: ...","week 4: ..."]}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    res.json(JSON.parse(text.replace(/```json|```/g, "").trim()));
  } catch (err) {
    console.error("AI error:", err);
    res.status(500).json({ error: "Failed to generate insights" });
  }
});

function buildAdvisorContext(db) {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const inWindow = db.transactions.filter(t => t.date >= cutoff);
  const txns = inWindow.filter(t => !EXCLUDED_FROM_SPEND.has(t.category));
  const total = txns.reduce((s, t) => s + t.amount, 0);
  const months = new Set(txns.map(t => t.date.slice(0, 7))).size || 1;
  const exchanged = inWindow.filter(t => t.category === "Currency Exchange").reduce((s, t) => s + t.amount, 0);

  const catMap = {};
  txns.forEach(t => { catMap[t.category] = (catMap[t.category] || 0) + t.amount; });
  const cats = Object.entries(catMap).sort((a, b) => b[1] - a[1]);

  const merchMap = {};
  const merchCount = {};
  txns.forEach(t => {
    const m = t.merchant || t.description;
    merchMap[m] = (merchMap[m] || 0) + t.amount;
    merchCount[m] = (merchCount[m] || 0) + 1;
  });
  const merchants = Object.entries(merchMap).sort((a, b) => b[1] - a[1]).slice(0, 30);

  const TXN_CAP = 2000;
  const sortedDesc = txns.slice().sort((a, b) => b.date.localeCompare(a.date));
  const truncated = sortedDesc.length > TXN_CAP;
  const shown = truncated ? sortedDesc.slice(0, TXN_CAP) : sortedDesc;
  const txnLines = shown.map(t =>
    `${t.date} | ${(t.merchant || t.description).slice(0, 40).padEnd(40)} | $${t.amount.toFixed(2).padStart(9)} | ${t.category}`
  ).join("\n");

  const dates = txns.map(t => t.date).sort();
  const oldest = dates[0] || "n/a";
  const newest = dates[dates.length - 1] || "n/a";

  // Pre-aggregate daily and monthly totals so the model never has to sum
  // dozens of lines mentally for common date-range queries.
  const dayMap = {};
  const monthMap = {};
  txns.forEach(t => {
    dayMap[t.date] = (dayMap[t.date] || 0) + t.amount;
    const ym = t.date.slice(0, 7);
    monthMap[ym] = (monthMap[ym] || 0) + t.amount;
  });
  const dailyLines = Object.entries(dayMap).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, v]) => `${d}: $${v.toFixed(2)}`).join("\n");
  const monthlyLines = Object.entries(monthMap).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([m, v]) => `${m}: $${v.toFixed(2)}`).join("\n");

  const truncationNote = truncated
    ? `\n\nNOTE: Only the ${TXN_CAP} most recent of ${txns.length} transactions are listed below. The CATEGORIES, TOP MERCHANTS, DAILY, and MONTHLY totals above include ALL ${txns.length} transactions. If asked to enumerate specific transactions outside the listed ${TXN_CAP}, say you don't have them in this context but can quote totals.`
    : "";

  return `You are a sharp, candid personal financial advisor with full read access to the user's last 90 days of transactions.

CRITICAL RULES — read these carefully and follow them:

1. TRUTHFULNESS. Every number you state must be derivable from the data below. Do not estimate, round generously, or recall from memory. If the user asks something the data doesn't answer, say so plainly.

2. SHOW YOUR ARITHMETIC. Before claiming a total, count, or comparison, enumerate the matching transactions in your reasoning (date, merchant, amount). Then sum them. Don't pattern-match — verify.

3. AMOUNT CONVENTIONS:
   - All amounts are in USD, converted from the source currency at the month-average ECB rate when imported.
   - POSITIVE amount = the user spent that money (debit).
   - NEGATIVE amount = a refund or reversal that reduces net spend in that category. Treat it as money returned.
   - Net spend = sum of all amounts (positives and negatives together).

4. EXCLUSIONS: "Currency Exchange" is wallet-to-wallet swaps and is already excluded from spending totals. Don't add it back. The exchanged amount is shown separately for context.

5. DATE RANGES. When the user asks about a period (e.g. "last week", "March", "2026-04-15 to 2026-04-22"), use the DAILY TOTALS table — sum the matching dates. Don't re-sum the transaction list.

6. CITATIONS. When citing a transaction, give exact date, merchant, and dollar amount. When the user disputes a number, recompute it from the transactions list, don't restate.

7. RECOMMENDATIONS. When suggesting cuts, prefer (a) discretionary categories with high totals (Dining, Subscriptions, Entertainment) over essentials (Groceries, Utilities, Medical), (b) merchants with high frequency (recurring habits), (c) one specific actionable move over vague platitudes. Quote the dollar impact.

8. STYLE. Concise. Use bullet points when listing. Use $X.XX format for currency. No filler ("Great question!" / "Let me help"). If a question is ambiguous, ask one short clarifying question instead of guessing.

DATA WINDOW
Total spending: $${total.toFixed(2)} over ${months} month(s) ($${(total / months).toFixed(2)}/mo avg)
Currency exchanged (excluded from spending): $${exchanged.toFixed(2)}
Transactions in window: ${txns.length} (${oldest} → ${newest}, today is ${new Date().toISOString().slice(0, 10)})${truncationNote}

CATEGORIES (full window, sorted by spend)
${cats.map(([c, v]) => `- ${c}: $${v.toFixed(2)}`).join("\n")}

TOP MERCHANTS (full window, by total spend, with frequency)
${merchants.map(([m, v]) => `- ${m}: $${v.toFixed(2)} (${merchCount[m]}x)`).join("\n")}

MONTHLY TOTALS (sum of all spend that month)
${monthlyLines}

DAILY TOTALS (sum of all spend that day)
${dailyLines}

TRANSACTIONS (date | merchant | amount | category, newest first)
${txnLines}`;
}

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "messages array required" });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
    }

    const db = loadDB();
    const systemPrompt = buildAdvisorContext(db);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 2048,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        messages,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("Chat API error:", data);
      return res.status(500).json({ error: data.error?.message || `HTTP ${response.status}` });
    }
    const textBlock = data.content?.find(b => b.type === "text");
    const text = textBlock?.text || "";
    res.json({
      message: text,
      usage: {
        input: data.usage?.input_tokens,
        cache_read: data.usage?.cache_read_input_tokens,
        cache_write: data.usage?.cache_creation_input_tokens,
        output: data.usage?.output_tokens,
      },
    });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Failed to generate response" });
  }
});

// ---------------------------------------------------------------------------
// Currency conversion — ECB rates via Frankfurter (free, no API key, daily refresh)
// ---------------------------------------------------------------------------
const RATE_TTL_MS = 24 * 60 * 60 * 1000;

async function getExchangeRates(db) {
  const cached = db.exchangeRates;
  if (cached && cached.rates && (Date.now() - cached.updatedAt) < RATE_TTL_MS) {
    return cached.rates;
  }
  try {
    const resp = await fetch("https://api.frankfurter.app/latest?from=USD");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const rates = { USD: 1, ...data.rates };
    db.exchangeRates = { rates, updatedAt: Date.now(), date: data.date };
    saveDB(db);
    return rates;
  } catch (err) {
    console.error("Failed to fetch exchange rates:", err.message);
    return cached?.rates || { USD: 1 };
  }
}

function toUsd(amount, currency, rates) {
  if (!currency || currency.toUpperCase() === "USD") return amount;
  if (!rates) return amount;
  const rate = rates[currency.toUpperCase()];
  if (!rate) return amount;
  return amount / rate;
}

// Average of daily ECB rates over a month. Once a month closes the average is
// fixed forever (cached). The current month is recomputed on a 24h TTL to fold
// in newly-published days.
async function getMonthlyAverageRates(yearMonth, db) {
  if (!db.exchangeRatesByMonth) db.exchangeRatesByMonth = {};
  const cached = db.exchangeRatesByMonth[yearMonth];
  const todayMonth = new Date().toISOString().slice(0, 7);
  const isClosed = yearMonth < todayMonth;
  if (cached?.rates && (isClosed || (Date.now() - cached.updatedAt) < RATE_TTL_MS)) {
    return cached.rates;
  }

  const [yr, mo] = yearMonth.split("-").map(Number);
  const startDate = `${yearMonth}-01`;
  const lastOfMonth = new Date(yr, mo, 0).getDate();
  const todayIso = new Date().toISOString().slice(0, 10);
  const monthEnd = `${yearMonth}-${String(lastOfMonth).padStart(2, "0")}`;
  const endDate = isClosed ? monthEnd : (todayIso < monthEnd ? todayIso : monthEnd);

  try {
    const resp = await fetch(`https://api.frankfurter.app/${startDate}..${endDate}?from=USD`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const sums = {};
    const counts = {};
    let dayCount = 0;
    for (const dayRates of Object.values(data.rates || {})) {
      dayCount++;
      for (const [ccy, rate] of Object.entries(dayRates)) {
        sums[ccy] = (sums[ccy] || 0) + rate;
        counts[ccy] = (counts[ccy] || 0) + 1;
      }
    }
    if (!dayCount) throw new Error(`no rates returned for ${yearMonth}`);
    const avg = { USD: 1 };
    for (const ccy of Object.keys(sums)) avg[ccy] = sums[ccy] / counts[ccy];

    db.exchangeRatesByMonth[yearMonth] = { rates: avg, updatedAt: Date.now(), days: dayCount };
    saveDB(db);
    return avg;
  } catch (err) {
    console.error(`Failed to fetch monthly rates for ${yearMonth}:`, err.message);
    return cached?.rates || null;
  }
}

async function getRatesForMonths(monthSet, db) {
  const result = {};
  for (const m of monthSet) {
    result[m] = await getMonthlyAverageRates(m, db);
  }
  return result;
}

app.get("/api/exchange-rates", async (req, res) => {
  const db = loadDB();
  const rates = await getExchangeRates(db);
  res.json({ rates, updatedAt: db.exchangeRates?.updatedAt, date: db.exchangeRates?.date });
});

// ---------------------------------------------------------------------------
// Routes: CSV / PDF import
// ---------------------------------------------------------------------------
async function extractTransactionsFromFile({ filename, mimeType, base64data }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const isPdf = (mimeType && mimeType.includes("pdf")) || /\.pdf$/i.test(filename || "");
  const isCsv = /\.csv$/i.test(filename || "") || mimeType === "text/csv" || mimeType === "text/plain";

  const instructions = `Extract every spending-relevant transaction from this financial statement.

INCLUDE as POSITIVE amounts (money the user spent):
- Card purchases
- ATM cash withdrawals (e.g. "Cash withdrawal at ...")
- Outgoing currency exchanges (e.g. "Exchanged to HUF") — keep the source-currency amount
- Outgoing transfers to people (e.g. "Transfer to JOHN SMITH")
- Subscription/plan fees, account fees

INCLUDE as NEGATIVE amounts (money returned to the user from a previous purchase):
- Refunds, returns, reversals, chargebacks (e.g. "Refund from SPAR")
- Use the merchant of the original purchase

SKIP entirely (true income, not refunds):
- Salary, payroll, wages
- Bank deposits, top-ups, account funding (e.g. "Top-up by *6365")
- Incoming person-to-person transfers (e.g. "Transfer from JOHN SMITH")
- Interest earned, dividends, cashback rewards
- Tax refunds from a government

Return ONLY a JSON array (no prose, no markdown fences) of objects with these fields:
- date: YYYY-MM-DD
- description: full original transaction description, INCLUDING any "Transfer to <NAME>", "Exchanged to <CCY>", or "Refund from <NAME>" prefix verbatim
- amount: number in the SOURCE currency. POSITIVE for spending, NEGATIVE for refunds. Do not convert.
- merchant: short cleaned merchant name suitable for grouping (e.g., "SPAR" not "SPAR 1234 BUDAPEST"). For transfers use the recipient name. For exchanges use "Exchange". For cash withdrawals use the ATM/location name. For refunds use the original merchant.
- currency: 3-letter ISO code of the source amount (e.g. "PLN", "EUR", "HUF", "USD")

Return [] if no spending-relevant transactions are found.`;

  let content;
  if (isPdf) {
    content = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64data } },
      { type: "text", text: instructions },
    ];
  } else if (isCsv) {
    const text = Buffer.from(base64data, "base64").toString("utf8").slice(0, 200_000);
    content = [{ type: "text", text: `${instructions}\n\nCSV CONTENT:\n${text}` }];
  } else {
    throw new Error(`Unsupported file type: ${mimeType || filename}`);
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
      messages: [{ role: "user", content }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }
  const text = data.content?.[0]?.text || "[]";
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
  if (!Array.isArray(parsed)) throw new Error("Model did not return a JSON array");

  return parsed
    .filter(t => t && t.date && Number.isFinite(Number(t.amount)) && Number(t.amount) !== 0 && (t.description || t.merchant))
    .map(t => ({
      date: String(t.date).slice(0, 10),
      description: String(t.description || t.merchant || "").slice(0, 200),
      amount: Number(t.amount),
      merchant: String(t.merchant || t.description || "").slice(0, 100),
      currency: (t.currency || "USD").toUpperCase().slice(0, 3),
    }));
}

function importTxnId(t, sourceLabel) {
  const h = crypto.createHash("sha1");
  h.update(`${sourceLabel}|${t.date}|${t.description}|${t.amount.toFixed(2)}`);
  return "imp_" + h.digest("hex").slice(0, 24);
}

// Normalize merchant strings for fuzzy comparison: lowercase, alphanumerics only.
function normalizeMerchant(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Heuristic: same calendar date + similar absolute amount (within $1 to absorb
// FX rounding) + merchant strings whose first 4+ alphanumeric chars overlap.
// Catches duplicates across imports and Plaid syncs.
function findCrossSourceDuplicate(t, existing) {
  const date = t.date;
  const newAmtAbs = Math.abs(Number(t.amount_usd ?? t.amount));
  const newM = normalizeMerchant(t.merchant || t.description);
  if (!newM || !date || !Number.isFinite(newAmtAbs)) return null;
  for (const x of existing) {
    if (x.date !== date) continue;
    if (Math.abs(Math.abs(x.amount) - newAmtAbs) > 1.0) continue;
    const xm = normalizeMerchant(x.merchant || x.description);
    if (!xm) continue;
    if (xm === newM) return x;
    const a = newM.slice(0, 5), b = xm.slice(0, 5);
    if (a.length >= 4 && (xm.startsWith(a) || newM.startsWith(b))) return x;
  }
  return null;
}

app.post("/api/import/parse", async (req, res) => {
  try {
    const { filename, mimeType, base64data } = req.body;
    if (!base64data) return res.status(400).json({ error: "base64data is required" });

    const extracted = await extractTransactionsFromFile({ filename, mimeType, base64data });

    const db = loadDB();
    const spotRates = await getExchangeRates(db);
    const months = new Set(extracted.map(t => (t.date || "").slice(0, 7)).filter(Boolean));
    const monthRates = await getRatesForMonths(months, db);

    extracted.forEach(t => {
      t.category = categorize([], t.merchant, db.merchantCache, t.description, db.merchantOverrides);
      t.amount_original = t.amount;
      t.currency_original = (t.currency || "USD").toUpperCase();
      const ym = (t.date || "").slice(0, 7);
      const rates = monthRates[ym] || spotRates;
      t.amount_usd = Number(toUsd(t.amount, t.currency_original, rates).toFixed(2));
      t.fx_month = ym;
      const dup = findCrossSourceDuplicate(t, db.transactions);
      if (dup) {
        t.duplicate_of = { id: dup.id, source: dup.source, date: dup.date, merchant: dup.merchant, amount: dup.amount };
      }
    });

    const dupCount = extracted.filter(t => t.duplicate_of).length;
    res.json({
      transactions: extracted,
      monthsUsed: [...months].sort(),
      duplicateCount: dupCount,
    });
  } catch (err) {
    console.error("Import parse error:", err);
    res.status(500).json({ error: err.message || "Failed to parse file" });
  }
});

app.post("/api/import/save", async (req, res) => {
  try {
    const { transactions, source, includeDuplicates } = req.body;
    if (!Array.isArray(transactions) || !transactions.length) {
      return res.status(400).json({ error: "transactions array is required" });
    }
    const sourceLabel = (source || "Imported").slice(0, 50);

    const db = loadDB();
    const spotRates = await getExchangeRates(db);
    const months = new Set(transactions.map(t => (t.date || "").slice(0, 7)).filter(Boolean));
    const monthRates = await getRatesForMonths(months, db);
    const existing = new Set(db.transactions.map(t => t.id));

    let added = 0;
    let skipped = 0;
    let dupSkipped = 0;
    let converted = 0;
    for (const t of transactions) {
      const id = importTxnId(t, sourceLabel);
      if (existing.has(id)) { skipped++; continue; }
      if (!includeDuplicates && findCrossSourceDuplicate(t, db.transactions)) {
        dupSkipped++;
        continue;
      }
      const origAmount = Number(t.amount_original ?? t.amount);
      const origCurrency = (t.currency_original || t.currency || "USD").toUpperCase();
      const ym = (t.date || "").slice(0, 7);
      const rates = monthRates[ym] || spotRates;
      const usdAmount = (typeof t.amount_usd === "number")
        ? t.amount_usd
        : toUsd(origAmount, origCurrency, rates);
      if (origCurrency !== "USD") converted++;
      db.transactions.push({
        id,
        account_id: `import:${sourceLabel}`,
        date: t.date,
        description: t.description,
        amount: Number(usdAmount.toFixed(2)),
        amount_original: origAmount,
        currency_original: origCurrency,
        fx_month: ym || undefined,
        category: t.category || categorize([], t.merchant, db.merchantCache, t.description, db.merchantOverrides),
        merchant: t.merchant || t.description || "",
        source: sourceLabel,
        currency: "USD",
      });
      existing.add(id);
      added++;
    }

    if (added > 0) {
      const aiResult = await classifyUnknownMerchants(db);
      db.transactions.sort((a, b) => b.date.localeCompare(a.date));
      saveDB(db);
      return res.json({ added, skipped, dupSkipped, converted, aiClassified: aiResult.classified, total: db.transactions.length });
    }
    res.json({ added, skipped, dupSkipped, converted, total: db.transactions.length });
  } catch (err) {
    console.error("Import save error:", err);
    res.status(500).json({ error: "Failed to save imported transactions" });
  }
});

// ---------------------------------------------------------------------------
// Catch-all
// ---------------------------------------------------------------------------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Re-categorize stored transactions on startup so categorizer changes
// take effect without requiring a re-sync.
(function recategorizeOnStartup() {
  const db = loadDB();
  if (!db.transactions.length) return;
  let changed = 0;
  db.transactions.forEach(t => {
    const fresh = categorize([], t.merchant, db.merchantCache, t.description, db.merchantOverrides);
    if (fresh !== t.category) { t.category = fresh; changed++; }
  });
  if (changed) {
    saveDB(db);
    console.log(`  Recategorized ${changed} transactions`);
  }
})();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ◉ MeridianWallet running at http://localhost:${PORT}\n`);
});
