require("dotenv").config({ override: true });
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Configuration, PlaidApi, PlaidEnvironments, Products } = require("plaid");

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// JSON file storage (zero native deps)
// ---------------------------------------------------------------------------
const DB_PATH = path.join(__dirname, "budgetpilot-data.json");

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      if (!data.merchantCache) data.merchantCache = {};
      return data;
    }
  } catch { }
  return { accounts: [], transactions: [], merchantCache: {} };
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Category mapping: regex fast path → AI classifier (cached) → "Other"
// ---------------------------------------------------------------------------
const CATEGORIES = [
  "Taxes & Government", "Groceries", "Dining & Restaurants", "Transport & Rides",
  "Flights & Travel", "Medical & Pharmacy", "Shopping & Online", "Subscriptions & Digital",
  "Home & Furniture", "Entertainment", "Clothing & Fashion", "Personal Care",
  "Utilities & Bills", "Transfers & Payments", "Other"
];

function categorize(plaidCategories, merchantName, cache) {
  const regex = mapCategory(plaidCategories, merchantName);
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

Return ONLY a JSON object mapping merchant → category. Use "Other" only when no category fits. Do not invent new categories.

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

  if (/government|tax authority/i.test(cats) || /e-pit|skarbowy|urząd|us skarbowy/i.test(m)) return "Taxes & Government";
  if (/groceries|supermarket/i.test(cats) || /spar|lidl|carrefour|frisco|zabka|biedronka|tesco|piekarnia|crazy butcher/i.test(m)) return "Groceries";
  if (/restaurant|dining|food and drink|cafe|coffee/i.test(cats) || /wolt|bolt food|kantin|kantyna|étterem|restauracja|kawiarnia|ramen|pizza|burger|sushi|wafu|frici|monokini|tarka macska/i.test(m)) return "Dining & Restaurants";
  if (/taxi|ride share|uber|lyft|bolt|transportation/i.test(cats) || /uber|bolt\.eu|taxi|budapestgo|simplep\*budapestgo/i.test(m)) return "Transport & Rides";
  if (/airlines|travel|hotel|lodging/i.test(cats) || /wizz|getyourguide|booking\.com|airbnb|ryanair|lot polish/i.test(m)) return "Flights & Travel";
  if (/pharmacy|health|medical|doctor|dentist/i.test(cats) || /taban medical|patika|apteka|medis|aurismed|lafit/i.test(m)) return "Medical & Pharmacy";
  if (/shops|shopping|online|amazon|ebay/i.test(cats) || /amazon|ebay|allegro|ikea|g2a\.com|moka united|shopinext/i.test(m)) return "Shopping & Online";
  if (/subscription|digital|streaming|software/i.test(cats) || /apple\.com|google \*|google one|imdbpro|audible|netflix|spotify|claude\.ai|openai|chatgpt|github|anthropic/i.test(m)) return "Subscriptions & Digital";
  if (/home|furniture|hardware/i.test(cats)) return "Home & Furniture";
  if (/entertainment|recreation|gaming/i.test(cats) || /getcracked|exponent member/i.test(m)) return "Entertainment";
  if (/clothing|apparel/i.test(cats) || /new yorker|reserved|dior|rossmann/i.test(m)) return "Clothing & Fashion";
  if (/personal care|beauty|barber|salon/i.test(cats) || /barber|salon|fryzjer/i.test(m)) return "Personal Care";
  if (/utilities|telecom|phone|internet|bills/i.test(cats) || /telekom|orange|t-mobile|play|plus gsm/i.test(m)) return "Utilities & Bills";
  if (/transfer|payment|bank/i.test(cats) || /blue media|simplep\*vimpay/i.test(m)) return "Transfers & Payments";
  return "Other";
}

// ---------------------------------------------------------------------------
// Plaid client
// ---------------------------------------------------------------------------
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || "sandbox"],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});
const plaid = new PlaidApi(plaidConfig);

const PLAID_COUNTRY_CODES = (process.env.PLAID_COUNTRY_CODES || "US")
  .split(",")
  .map(c => c.trim().toUpperCase())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Routes: Plaid Link
// ---------------------------------------------------------------------------

app.post("/api/plaid/create-link-token", async (req, res) => {
  try {
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: "budgetpilot-user-1" },
      client_name: "BudgetPilot",
      products: [Products.Transactions],
      country_codes: PLAID_COUNTRY_CODES,
      language: "en",
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Link token error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

app.post("/api/plaid/exchange-token", async (req, res) => {
  try {
    const { public_token, institution } = req.body;
    const exchange = await plaid.itemPublicTokenExchange({ public_token });
    const access_token = exchange.data.access_token;
    const item_id = exchange.data.item_id;
    const accts = await plaid.accountsGet({ access_token });

    const db = loadDB();
    const saved = [];

    for (const acct of accts.data.accounts) {
      const existing = db.accounts.findIndex(a => a.id === acct.account_id);
      const record = {
        id: acct.account_id,
        institution_name: institution?.name || "Unknown",
        account_name: acct.name,
        account_type: acct.subtype || acct.type,
        access_token,
        item_id,
      };
      if (existing >= 0) db.accounts[existing] = record;
      else db.accounts.push(record);
      saved.push({ id: acct.account_id, name: acct.name, type: acct.subtype });
    }

    saveDB(db);
    res.json({ accounts: saved });
  } catch (err) {
    console.error("Exchange error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange token" });
  }
});

app.post("/api/plaid/sync-transactions", async (req, res) => {
  try {
    const db = loadDB();
    const tokenSet = new Map();
    db.accounts.forEach(a => tokenSet.set(a.access_token, a.institution_name));

    let totalAdded = 0;
    const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = new Date().toISOString().slice(0, 10);
    const existingIds = new Set(db.transactions.map(t => t.id));

    // Re-categorize existing transactions so a categorizer fix is reflected
    // without forcing the user to wipe their data.
    db.transactions.forEach(t => {
      t.category = categorize([], t.merchant || t.description, db.merchantCache);
    });

    for (const [access_token, institution_name] of tokenSet) {
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const txnResp = await plaid.transactionsGet({
          access_token,
          start_date: startDate,
          end_date: endDate,
          options: { count: 500, offset },
        });

        for (const t of txnResp.data.transactions) {
          if (t.amount <= 0) continue;
          if (existingIds.has(t.transaction_id)) continue;

          db.transactions.push({
            id: t.transaction_id,
            account_id: t.account_id,
            date: t.date,
            description: t.name || t.merchant_name || "Unknown",
            amount: t.amount,
            category: categorize(t.category, t.merchant_name || t.name, db.merchantCache),
            merchant: t.merchant_name || t.name || "",
            source: institution_name,
            currency: t.iso_currency_code || "USD",
          });
          existingIds.add(t.transaction_id);
          totalAdded++;
        }

        hasMore = txnResp.data.total_transactions > offset + txnResp.data.transactions.length;
        offset += txnResp.data.transactions.length;
      }
    }

    db.transactions.sort((a, b) => b.date.localeCompare(a.date));

    const aiResult = await classifyUnknownMerchants(db);

    saveDB(db);
    res.json({ added: totalAdded, total: db.transactions.length, aiClassified: aiResult.classified });
  } catch (err) {
    console.error("Sync error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to sync transactions" });
  }
});

// ---------------------------------------------------------------------------
// Routes: Data queries
// ---------------------------------------------------------------------------

app.get("/api/accounts", (req, res) => {
  const db = loadDB();
  res.json(db.accounts.map(({ access_token, ...rest }) => rest));
});

app.post("/api/recategorize", async (req, res) => {
  try {
    const db = loadDB();
    db.transactions.forEach(t => {
      t.category = categorize([], t.merchant || t.description, db.merchantCache);
    });
    const aiResult = await classifyUnknownMerchants(db);
    saveDB(db);
    const stillOther = db.transactions.filter(t => t.category === "Other").length;
    res.json({ total: db.transactions.length, aiClassified: aiResult.classified, stillOther });
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

    const stillUsed = db.accounts.some(a => a.access_token === target.access_token);
    let itemRevoked = false;
    if (!stillUsed) {
      try {
        await plaid.itemRemove({ access_token: target.access_token });
        itemRevoked = true;
      } catch (err) {
        console.error("Plaid itemRemove failed (continuing anyway):", err.response?.data || err.message);
      }
    }

    saveDB(db);
    res.json({ removed: target.id, removedTxns, itemRevoked });
  } catch (err) {
    console.error("Delete account error:", err.response?.data || err.message);
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
  const txns = db.transactions.filter(t => t.date >= cutoff);

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
    byWeek: Object.entries(weekMap).sort((a, b) => a[0].localeCompare(b[0])).map(([_, v]) => ({ week: v.label, total: v.total })),
    bySource: Object.values(srcMap).sort((a, b) => b.total - a.total),
    topMerchants: Object.values(merchMap).filter(m => m.count >= 2).sort((a, b) => b.total - a.total).slice(0, 15),
  });
});

// ---------------------------------------------------------------------------
// Routes: AI Insights
// ---------------------------------------------------------------------------
app.post("/api/insights", async (req, res) => {
  try {
    const db = loadDB();
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const txns = db.transactions.filter(t => t.date >= cutoff);

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
  const txns = db.transactions.filter(t => t.date >= cutoff);
  const total = txns.reduce((s, t) => s + t.amount, 0);
  const months = new Set(txns.map(t => t.date.slice(0, 7))).size || 1;

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

  const txnLines = txns.slice(0, 250).map(t =>
    `${t.date} | ${(t.merchant || t.description).slice(0, 40).padEnd(40)} | $${t.amount.toFixed(2).padStart(8)} | ${t.category}`
  ).join("\n");

  return `You are a sharp, candid personal financial advisor with full read access to the user's last 90 days of spending. Ground every answer in their actual transactions — cite specific merchants, dates, and dollar amounts when relevant. Be concise unless they ask for depth. Never make up numbers; if the data doesn't show something, say so.

SUMMARY
Total: $${total.toFixed(0)} over ${months} month(s) ($${(total / months).toFixed(0)}/mo avg)

CATEGORIES
${cats.map(([c, v]) => `- ${c}: $${v.toFixed(0)}`).join("\n")}

TOP MERCHANTS (by total spend)
${merchants.map(([m, v]) => `- ${m}: $${v.toFixed(0)} (${merchCount[m]}x)`).join("\n")}

TRANSACTIONS (date | merchant | amount | category)
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
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        messages,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("Chat API error:", data);
      return res.status(500).json({ error: data.error?.message || `HTTP ${response.status}` });
    }
    const text = data.content?.[0]?.text || "";
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
// Routes: CSV / PDF import
// ---------------------------------------------------------------------------
async function extractTransactionsFromFile({ filename, mimeType, base64data }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const isPdf = (mimeType && mimeType.includes("pdf")) || /\.pdf$/i.test(filename || "");
  const isCsv = /\.csv$/i.test(filename || "") || mimeType === "text/csv" || mimeType === "text/plain";

  const instructions = `Extract every spending transaction from this financial statement.

Return ONLY a JSON array (no prose, no markdown fences) of objects with these exact fields:
- date: YYYY-MM-DD
- description: full original line text (cleaned of obvious garbage)
- amount: positive number representing money the user SPENT (debit/charge). SKIP refunds, deposits, transfers in, salary, and any credit/positive-balance line.
- merchant: short cleaned merchant name suitable for grouping (e.g., "SPAR" not "SPAR 1234 BUDAPEST 12-04")
- currency: 3-letter ISO code (default "USD" if unclear)

Return [] if no spending transactions are found.`;

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
    .filter(t => t && t.date && t.amount > 0 && (t.description || t.merchant))
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

app.post("/api/import/parse", async (req, res) => {
  try {
    const { filename, mimeType, base64data } = req.body;
    if (!base64data) return res.status(400).json({ error: "base64data is required" });

    const extracted = await extractTransactionsFromFile({ filename, mimeType, base64data });

    const db = loadDB();
    extracted.forEach(t => {
      t.category = categorize([], t.merchant || t.description, db.merchantCache);
    });

    res.json({ transactions: extracted });
  } catch (err) {
    console.error("Import parse error:", err);
    res.status(500).json({ error: err.message || "Failed to parse file" });
  }
});

app.post("/api/import/save", async (req, res) => {
  try {
    const { transactions, source } = req.body;
    if (!Array.isArray(transactions) || !transactions.length) {
      return res.status(400).json({ error: "transactions array is required" });
    }
    const sourceLabel = (source || "Imported").slice(0, 50);

    const db = loadDB();
    const existing = new Set(db.transactions.map(t => t.id));

    let added = 0;
    let skipped = 0;
    for (const t of transactions) {
      const id = importTxnId(t, sourceLabel);
      if (existing.has(id)) { skipped++; continue; }
      db.transactions.push({
        id,
        account_id: `import:${sourceLabel}`,
        date: t.date,
        description: t.description,
        amount: Number(t.amount),
        category: t.category || categorize([], t.merchant || t.description, db.merchantCache),
        merchant: t.merchant || t.description || "",
        source: sourceLabel,
        currency: t.currency || "USD",
      });
      existing.add(id);
      added++;
    }

    if (added > 0) {
      const aiResult = await classifyUnknownMerchants(db);
      db.transactions.sort((a, b) => b.date.localeCompare(a.date));
      saveDB(db);
      return res.json({ added, skipped, aiClassified: aiResult.classified, total: db.transactions.length });
    }
    res.json({ added, skipped, total: db.transactions.length });
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
    const fresh = categorize([], t.merchant || t.description, db.merchantCache);
    if (fresh !== t.category) { t.category = fresh; changed++; }
  });
  if (changed) {
    saveDB(db);
    console.log(`  Recategorized ${changed} transactions`);
  }
})();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ◉ BudgetPilot running at http://localhost:${PORT}\n`);
});
