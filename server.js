require("dotenv").config({ override: true });
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { Configuration, PlaidApi, PlaidEnvironments, Products } = require("plaid");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// JSON file storage (zero native deps)
// ---------------------------------------------------------------------------
const DB_PATH = path.join(__dirname, "budgetpilot-data.json");

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch { }
  return { accounts: [], transactions: [] };
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Category mapping from Plaid categories
// ---------------------------------------------------------------------------
function mapCategory(plaidCategories, merchantName) {
  const cats = (plaidCategories || []).join(" ").toLowerCase();
  const m = (merchantName || "").toLowerCase();

  if (/groceries|supermarket/i.test(cats) || /spar|lidl|carrefour|frisco|zabka/i.test(m)) return "Groceries";
  if (/restaurant|dining|food and drink|cafe|coffee/i.test(cats)) return "Dining & Restaurants";
  if (/taxi|ride share|uber|lyft|bolt|transportation/i.test(cats) || /uber|bolt\.eu|taxi/i.test(m)) return "Transport & Rides";
  if (/airlines|travel|hotel|lodging/i.test(cats) || /wizz air|getyourguide/i.test(m)) return "Flights & Travel";
  if (/pharmacy|health|medical|doctor|dentist/i.test(cats) || /taban medical|patika|apteka|medis/i.test(m)) return "Medical & Pharmacy";
  if (/shops|shopping|online|amazon|ebay/i.test(cats) || /amazon|ebay|allegro|ikea/i.test(m)) return "Shopping & Online";
  if (/subscription|digital|streaming|software/i.test(cats) || /apple\.com|google \*|imdbpro|audible|netflix|spotify/i.test(m)) return "Subscriptions & Digital";
  if (/home|furniture|hardware/i.test(cats)) return "Home & Furniture";
  if (/entertainment|recreation|gaming/i.test(cats)) return "Entertainment";
  if (/clothing|apparel/i.test(cats) || /new yorker|reserved|dior|rossmann/i.test(m)) return "Clothing & Fashion";
  if (/utilities|telecom|phone|internet|bills/i.test(cats)) return "Utilities & Bills";
  if (/transfer|payment|bank/i.test(cats)) return "Transfers & Payments";
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
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = new Date().toISOString().slice(0, 10);
    const existingIds = new Set(db.transactions.map(t => t.id));

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
            category: mapCategory(t.category, t.merchant_name),
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
    saveDB(db);
    res.json({ added: totalAdded, total: db.transactions.length });
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
  txns.forEach(t => {
    const d = new Date(t.date);
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    const key = `${d.getFullYear()}-${String(week).padStart(2, "0")}`;
    weekMap[key] = (weekMap[key] || 0) + t.amount;
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
    byWeek: Object.entries(weekMap).sort((a, b) => a[0].localeCompare(b[0])).map(([week, total]) => ({ week, total })),
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

// ---------------------------------------------------------------------------
// Catch-all
// ---------------------------------------------------------------------------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ◉ BudgetPilot running at http://localhost:${PORT}\n`);
});
