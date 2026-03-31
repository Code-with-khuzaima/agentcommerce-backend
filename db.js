require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, "agentcommerce.db");
const USE_POSTGRES = (process.env.DB_TYPE || "").toLowerCase() === "postgres" && !!process.env.DATABASE_URL;

const PLAN_CONFIG = {
  starter: { price: 19, msgLimit: 5000 },
  pro: { price: 29, msgLimit: 13000 },
  enterprise: { price: 49, msgLimit: 999999 },
};

let sqliteDb = null;
let pgPool = null;

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatStoreIdentifier(id) {
  return `store_${String(id).padStart(3, "0")}`;
}

function getPlanMeta(plan) {
  return PLAN_CONFIG[plan] || PLAN_CONFIG.starter;
}

function nowIso() {
  return new Date().toISOString();
}

async function getPgPool() {
  if (pgPool) return pgPool;
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });
  return pgPool;
}

async function getSqliteDb() {
  if (sqliteDb) return sqliteDb;
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    sqliteDb = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    sqliteDb = new SQL.Database();
  }
  return sqliteDb;
}

function saveSqliteDb() {
  if (!sqliteDb) return;
  fs.writeFileSync(DB_PATH, Buffer.from(sqliteDb.export()));
}

function sqliteRun(database, sql, params = []) {
  database.run(sql, params);
}

function sqliteQueryAll(database, sql, params = []) {
  const stmt = database.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function sqliteQueryOne(database, sql, params = []) {
  return sqliteQueryAll(database, sql, params)[0] || null;
}

function buildStoreLookupClause(idOrIdentifier) {
  const raw = String(idOrIdentifier || "").trim();
  const numeric = Number(raw);
  if (raw && !Number.isNaN(numeric) && /^\d+$/.test(raw)) {
    return { isNumeric: true, value: numeric };
  }
  return { isNumeric: false, value: raw };
}

function hydrateStore(row) {
  if (!row) return null;

  const categories = parseJson(row.categories, []);
  const deliveryMethods = parseJson(row.delivery_methods, []);
  const storeAnswers = parseJson(row.store_answers, {});
  const credentials = parseJson(row.credentials, {});
  const usageLeft = Math.max(Number(row.msg_limit || 0) - Number(row.msg_count || 0), 0);
  const qnaText = row.faqs || "";
  const qnaCount = Number(row.qna_count || 0) || (qnaText ? qnaText.split(/\n+/).filter(Boolean).length : 0);

  return {
    id: Number(row.id),
    storeId: row.store_identifier || formatStoreIdentifier(row.id),
    storeUrl: row.store_url,
    platform: row.platform,
    storeName: row.store_name,
    contactEmail: row.contact_email,
    loginEmail: row.login_email || "",
    phoneNumber: row.phone_number || "",
    hasPhysicalStore: Number(row.has_physical_store || 0) === 1,
    storeAddress: row.store_address || "",
    billingCycle: row.billing_cycle || "monthly",
    categories,
    deliveryMethods,
    returnPolicy: row.return_policy || "",
    faqs: row.faqs || "",
    notes: row.notes || "",
    status: row.status || "pending",
    plan: row.plan || "starter",
    planPrice: Number(row.plan_price || 0),
    msgLimit: Number(row.msg_limit || 0),
    msgCount: Number(row.msg_count || 0),
    usageLeft,
    paymentStatus: row.payment_status || "pending",
    paymentAmount: Number(row.payment_amount || row.plan_price || 0),
    currency: row.currency || "USD",
    setupStatus: row.setup_status || "new",
    workflowStatus: row.workflow_status || "not_started",
    widgetStatus: row.widget_status || "not_installed",
    priority: row.priority || "medium",
    agentName: row.agent_name || "",
    accentColor: row.accent_color || "#7c3aed",
    welcomeMessage: row.welcome_message || "",
    webhookUrl: row.webhook_url || "",
    internalNotes: row.internal_notes || "",
    fullDetails: row.full_details || "",
    storeAnswers,
    qnaCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    lastActiveAt: row.last_active_at || null,
    lastSyncedAt: row.last_synced_at || null,
    credentialsPresent: Object.values(credentials || {}).some(Boolean),
    credentials,
  };
}

async function initPostgres() {
  const pool = await getPgPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stores (
      id SERIAL PRIMARY KEY,
      store_identifier TEXT UNIQUE,
      store_url TEXT NOT NULL,
      platform TEXT NOT NULL,
      store_name TEXT NOT NULL,
      contact_email TEXT NOT NULL,
      login_email TEXT DEFAULT '',
      phone_number TEXT DEFAULT '',
      has_physical_store INTEGER DEFAULT 0,
      store_address TEXT DEFAULT '',
      billing_cycle TEXT DEFAULT 'monthly',
      credentials TEXT NOT NULL,
      categories TEXT DEFAULT '[]',
      delivery_methods TEXT DEFAULT '[]',
      return_policy TEXT DEFAULT '',
      faqs TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      plan TEXT DEFAULT 'starter',
      plan_price INTEGER DEFAULT 19,
      msg_limit INTEGER DEFAULT 5000,
      msg_count INTEGER DEFAULT 0,
      payment_status TEXT DEFAULT 'pending',
      payment_amount INTEGER DEFAULT 19,
      currency TEXT DEFAULT 'USD',
      setup_status TEXT DEFAULT 'new',
      workflow_status TEXT DEFAULT 'not_started',
      widget_status TEXT DEFAULT 'not_installed',
      priority TEXT DEFAULT 'medium',
      agent_name TEXT DEFAULT '',
      accent_color TEXT DEFAULT '#7c3aed',
      welcome_message TEXT DEFAULT '',
      webhook_url TEXT DEFAULT '',
      internal_notes TEXT DEFAULT '',
      qna_count INTEGER DEFAULT 0,
      full_details TEXT DEFAULT '',
      store_answers TEXT DEFAULT '{}',
      last_active_at TIMESTAMPTZ,
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS integration_logs (
      id SERIAL PRIMARY KEY,
      store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      event TEXT NOT NULL,
      payload TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      store_id TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query("CREATE INDEX IF NOT EXISTS idx_stores_identifier ON stores(store_identifier)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_logs_store_id ON integration_logs(store_id)");
}

async function initSqlite() {
  const database = await getSqliteDb();
  sqliteRun(database, `
    CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_url TEXT NOT NULL,
      platform TEXT NOT NULL,
      store_name TEXT NOT NULL,
      contact_email TEXT NOT NULL,
      credentials TEXT NOT NULL,
      categories TEXT DEFAULT '[]',
      delivery_methods TEXT DEFAULT '[]',
      return_policy TEXT DEFAULT '',
      faqs TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  sqliteRun(database, `
    CREATE TABLE IF NOT EXISTS integration_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER,
      event TEXT NOT NULL,
      payload TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  sqliteRun(database, `
    CREATE TABLE IF NOT EXISTS client_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      store_id TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const existingColumns = new Set(sqliteQueryAll(database, "PRAGMA table_info(stores)").map((col) => col.name));
  const migrations = [
    ["plan", "TEXT DEFAULT 'starter'"],
    ["plan_price", "INTEGER DEFAULT 19"],
    ["msg_limit", "INTEGER DEFAULT 5000"],
    ["msg_count", "INTEGER DEFAULT 0"],
    ["payment_status", "TEXT DEFAULT 'pending'"],
    ["payment_amount", "INTEGER DEFAULT 0"],
    ["currency", "TEXT DEFAULT 'USD'"],
    ["setup_status", "TEXT DEFAULT 'new'"],
    ["workflow_status", "TEXT DEFAULT 'not_started'"],
    ["widget_status", "TEXT DEFAULT 'not_installed'"],
    ["priority", "TEXT DEFAULT 'medium'"],
    ["store_identifier", "TEXT"],
    ["agent_name", "TEXT DEFAULT ''"],
    ["accent_color", "TEXT DEFAULT '#7c3aed'"],
    ["welcome_message", "TEXT DEFAULT ''"],
    ["webhook_url", "TEXT DEFAULT ''"],
    ["last_active_at", "DATETIME"],
    ["last_synced_at", "DATETIME"],
    ["internal_notes", "TEXT DEFAULT ''"],
    ["qna_count", "INTEGER DEFAULT 0"],
    ["full_details", "TEXT DEFAULT ''"],
    ["store_answers", "TEXT DEFAULT '{}'"],
    ["billing_cycle", "TEXT DEFAULT 'monthly'"],
    ["login_email", "TEXT DEFAULT ''"],
    ["phone_number", "TEXT DEFAULT ''"],
    ["has_physical_store", "INTEGER DEFAULT 0"],
    ["store_address", "TEXT DEFAULT ''"],
    ["updated_at", "DATETIME DEFAULT CURRENT_TIMESTAMP"],
  ];

  for (const [name, definition] of migrations) {
    if (!existingColumns.has(name)) sqliteRun(database, `ALTER TABLE stores ADD COLUMN ${name} ${definition}`);
  }

  sqliteRun(database, "UPDATE stores SET store_identifier = COALESCE(store_identifier, '') WHERE store_identifier IS NULL");
  sqliteRun(database, "UPDATE stores SET updated_at = COALESCE(updated_at, created_at)");
  sqliteRun(database, "UPDATE stores SET plan = COALESCE(plan, 'starter')");
  sqliteRun(database, "UPDATE stores SET plan_price = CASE plan WHEN 'pro' THEN 29 WHEN 'enterprise' THEN 49 ELSE 19 END");
  sqliteRun(database, "UPDATE stores SET payment_amount = CASE WHEN payment_amount IS NULL OR payment_amount = 0 THEN plan_price ELSE payment_amount END");
  sqliteRun(database, "UPDATE stores SET msg_limit = CASE plan WHEN 'pro' THEN 13000 WHEN 'enterprise' THEN 999999 ELSE 5000 END WHERE msg_limit IS NULL OR msg_limit = 0");

  const missingIdentifiers = sqliteQueryAll(database, "SELECT id FROM stores WHERE store_identifier IS NULL OR store_identifier = ''");
  for (const row of missingIdentifiers) {
    sqliteRun(database, "UPDATE stores SET store_identifier = ? WHERE id = ?", [formatStoreIdentifier(row.id), row.id]);
  }

  saveSqliteDb();
}

async function initDb() {
  if (USE_POSTGRES) {
    await initPostgres();
  } else {
    await initSqlite();
  }
  console.log(`Database schema ready (${USE_POSTGRES ? "postgres" : "sqlite"})`);
}

async function createSubmission(payload) {
  const {
    storeUrl,
    platform,
    storeName,
    contactEmail,
    loginEmail = "",
    phoneNumber = "",
    hasPhysicalStore = false,
    storeAddress = "",
    billingCycle = "monthly",
    credentials,
    categories,
    deliveryMethods,
    returnPolicy,
    faqs,
    notes,
    plan = "starter",
    storeAnswers = "{}",
    fullDetails = "",
    qnaCount = 0,
  } = payload;

  const planMeta = getPlanMeta(plan);

  if (USE_POSTGRES) {
    const pool = await getPgPool();
    const inserted = await pool.query(
      `INSERT INTO stores (
        store_url, platform, store_name, contact_email, login_email, phone_number,
        has_physical_store, store_address, billing_cycle, credentials, categories,
        delivery_methods, return_policy, faqs, notes, status, plan, plan_price,
        msg_limit, msg_count, payment_status, payment_amount, currency, setup_status,
        workflow_status, widget_status, priority, agent_name, accent_color,
        welcome_message, webhook_url, internal_notes, qna_count, full_details,
        store_answers, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36
      ) RETURNING id`,
      [
        storeUrl, platform, storeName, contactEmail, loginEmail, phoneNumber,
        hasPhysicalStore ? 1 : 0, storeAddress, billingCycle, credentials, categories,
        deliveryMethods, returnPolicy, faqs, notes, "pending", plan, planMeta.price,
        planMeta.msgLimit, 0, "pending", planMeta.price, "USD", "new", "not_started",
        "not_installed", "medium", `${storeName} Assistant`, "#7c3aed",
        `Hi! Welcome to ${storeName}.`, "", "", qnaCount, fullDetails, storeAnswers, nowIso(),
      ]
    );
    const id = Number(inserted.rows[0].id);
    const storeIdentifier = formatStoreIdentifier(id);
    await pool.query("UPDATE stores SET store_identifier = $1 WHERE id = $2", [storeIdentifier, id]);
    return { id, storeIdentifier, planPrice: planMeta.price, msgLimit: planMeta.msgLimit };
  }

  const database = await getSqliteDb();
  sqliteRun(
    database,
    `INSERT INTO stores
      (store_url, platform, store_name, contact_email, credentials,
       categories, delivery_methods, return_policy, faqs, notes,
       status, plan, plan_price, msg_limit, msg_count,
       payment_status, payment_amount, currency,
       setup_status, workflow_status, widget_status, priority,
       agent_name, accent_color, welcome_message, webhook_url,
       internal_notes, qna_count, full_details, store_answers,
       billing_cycle, login_email, phone_number, has_physical_store, store_address, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      storeUrl, platform, storeName, contactEmail, credentials,
      categories, deliveryMethods, returnPolicy, faqs, notes,
      "pending", plan, planMeta.price, planMeta.msgLimit, 0,
      "pending", planMeta.price, "USD",
      "new", "not_started", "not_installed", "medium",
      `${storeName} Assistant`, "#7c3aed", `Hi! Welcome to ${storeName}.`, "",
      "", qnaCount, fullDetails, storeAnswers,
      billingCycle, loginEmail, phoneNumber, hasPhysicalStore ? 1 : 0, storeAddress,
    ]
  );
  const result = sqliteQueryOne(database, "SELECT last_insert_rowid() AS id");
  const id = Number(result.id);
  const storeIdentifier = formatStoreIdentifier(id);
  sqliteRun(database, "UPDATE stores SET store_identifier = ? WHERE id = ?", [storeIdentifier, id]);
  saveSqliteDb();
  return { id, storeIdentifier, planPrice: planMeta.price, msgLimit: planMeta.msgLimit };
}

async function getSubmissionById(idOrIdentifier) {
  const lookup = buildStoreLookupClause(idOrIdentifier);

  if (USE_POSTGRES) {
    const pool = await getPgPool();
    const res = lookup.isNumeric
      ? await pool.query("SELECT * FROM stores WHERE id = $1", [lookup.value])
      : await pool.query("SELECT * FROM stores WHERE store_identifier = $1", [lookup.value]);
    return hydrateStore(res.rows[0] || null);
  }

  const database = await getSqliteDb();
  const row = lookup.isNumeric
    ? sqliteQueryOne(database, "SELECT * FROM stores WHERE id = ?", [lookup.value])
    : sqliteQueryOne(database, "SELECT * FROM stores WHERE store_identifier = ?", [lookup.value]);
  return hydrateStore(row);
}

async function listStores(filters = {}) {
  const clauses = [];
  const params = [];
  const addFilter = (sql, value) => {
    clauses.push(sql);
    params.push(value);
  };

  if (filters.status && filters.status !== "all") addFilter("status = ?", filters.status);
  if (filters.plan && filters.plan !== "all") addFilter("plan = ?", filters.plan);
  if (filters.platform && filters.platform !== "all") addFilter("platform = ?", filters.platform);
  if (filters.paymentStatus && filters.paymentStatus !== "all") addFilter("payment_status = ?", filters.paymentStatus);
  if (filters.setupStatus && filters.setupStatus !== "all") addFilter("setup_status = ?", filters.setupStatus);
  if (filters.search) {
    clauses.push("(store_name LIKE ? OR store_url LIKE ? OR contact_email LIKE ? OR store_identifier LIKE ?)");
    const like = `%${filters.search}%`;
    params.push(like, like, like, like);
  }

  if (USE_POSTGRES) {
    const pool = await getPgPool();
    let idx = 1;
    const pgClauses = clauses.map((clause) => clause.replace(/\?/g, () => `$${idx++}`).replace(/LIKE/g, "ILIKE"));
    const where = pgClauses.length ? `WHERE ${pgClauses.join(" AND ")}` : "";
    const res = await pool.query(
      `SELECT * FROM stores ${where}
       ORDER BY CASE status
         WHEN 'pending' THEN 0
         WHEN 'review' THEN 1
         WHEN 'active' THEN 2
         WHEN 'paused' THEN 3
         WHEN 'archived' THEN 4
         ELSE 5
       END, created_at DESC`,
      params
    );
    return res.rows.map(hydrateStore);
  }

  const database = await getSqliteDb();
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = sqliteQueryAll(
    database,
    `SELECT * FROM stores ${where}
     ORDER BY CASE status
       WHEN 'pending' THEN 0
       WHEN 'review' THEN 1
       WHEN 'active' THEN 2
       WHEN 'paused' THEN 3
       WHEN 'archived' THEN 4
       ELSE 5
     END, datetime(created_at) DESC`,
    params
  );
  return rows.map(hydrateStore);
}

async function getStoreDetails(idOrIdentifier) {
  const store = await getSubmissionById(idOrIdentifier);
  if (!store) return null;

  if (USE_POSTGRES) {
    const pool = await getPgPool();
    const res = await pool.query(
      "SELECT * FROM integration_logs WHERE store_id = $1 ORDER BY created_at DESC LIMIT 40",
      [store.id]
    );
    return {
      ...store,
      logs: res.rows.map((row) => ({
        id: Number(row.id),
        storeId: Number(row.store_id),
        event: row.event,
        payload: parseJson(row.payload, row.payload || {}),
        createdAt: row.created_at,
      })),
    };
  }

  const database = await getSqliteDb();
  const logs = sqliteQueryAll(
    database,
    "SELECT * FROM integration_logs WHERE store_id = ? ORDER BY datetime(created_at) DESC LIMIT 40",
    [store.id]
  ).map((row) => ({
    id: Number(row.id),
    storeId: Number(row.store_id),
    event: row.event,
    payload: parseJson(row.payload, row.payload || {}),
    createdAt: row.created_at,
  }));
  return { ...store, logs };
}

async function getDashboardSummary() {
  const stores = await listStores({});
  const summary = {
    totalStores: stores.length,
    pendingStores: 0,
    activeStores: 0,
    pausedStores: 0,
    enterpriseStores: 0,
    monthlyRevenue: 0,
    collectedRevenue: 0,
    unpaidRevenue: 0,
    totalMessagesUsed: 0,
    totalUsageLeft: 0,
    setupQueue: 0,
    widgetLive: 0,
    workflowReady: 0,
    paymentPending: 0,
    recentStores: stores.slice(0, 5),
  };

  for (const store of stores) {
    if (store.status === "pending" || store.setupStatus === "new") summary.pendingStores += 1;
    if (store.status === "active") summary.activeStores += 1;
    if (store.status === "paused") summary.pausedStores += 1;
    if (store.plan === "enterprise") summary.enterpriseStores += 1;
    if (store.paymentStatus === "paid") summary.collectedRevenue += store.paymentAmount;
    if (store.paymentStatus !== "paid") {
      summary.paymentPending += 1;
      summary.unpaidRevenue += store.paymentAmount;
    }
    if (store.setupStatus !== "live") summary.setupQueue += 1;
    if (store.widgetStatus === "live") summary.widgetLive += 1;
    if (store.workflowStatus === "ready" || store.workflowStatus === "live") summary.workflowReady += 1;
    summary.monthlyRevenue += store.planPrice;
    summary.totalMessagesUsed += store.msgCount;
    summary.totalUsageLeft += store.usageLeft;
  }

  return summary;
}

async function updateStore(id, updates) {
  const current = await getSubmissionById(id);
  if (!current) return null;

  const nextPlan = updates.plan || current.plan || "starter";
  const planMeta = getPlanMeta(nextPlan);
  const fields = {
    store_name: updates.storeName ?? current.storeName,
    contact_email: updates.contactEmail ?? current.contactEmail,
    status: updates.status ?? current.status,
    plan: nextPlan,
    plan_price: updates.planPrice ?? (updates.plan ? planMeta.price : current.planPrice),
    msg_limit: updates.msgLimit ?? (updates.plan ? planMeta.msgLimit : current.msgLimit),
    msg_count: updates.msgCount ?? current.msgCount,
    payment_status: updates.paymentStatus ?? current.paymentStatus,
    payment_amount: updates.paymentAmount ?? (updates.plan ? planMeta.price : current.paymentAmount),
    setup_status: updates.setupStatus ?? current.setupStatus,
    workflow_status: updates.workflowStatus ?? current.workflowStatus,
    widget_status: updates.widgetStatus ?? current.widgetStatus,
    priority: updates.priority ?? current.priority,
    webhook_url: updates.webhookUrl ?? current.webhookUrl,
    agent_name: updates.agentName ?? current.agentName,
    accent_color: updates.accentColor ?? current.accentColor,
    welcome_message: updates.welcomeMessage ?? current.welcomeMessage,
    internal_notes: updates.internalNotes ?? current.internalNotes,
    last_active_at: updates.lastActiveAt ?? current.lastActiveAt,
    last_synced_at: updates.lastSyncedAt ?? current.lastSyncedAt,
    updated_at: nowIso(),
  };

  if (USE_POSTGRES) {
    const pool = await getPgPool();
    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const setClause = keys.map((key, index) => `${key} = $${index + 1}`).join(", ");
    await pool.query(`UPDATE stores SET ${setClause} WHERE id = $${keys.length + 1}`, [...values, Number(id)]);
    return getStoreDetails(id);
  }

  const database = await getSqliteDb();
  const setClause = Object.keys(fields).map((key) => `${key} = ?`).join(", ");
  sqliteRun(database, `UPDATE stores SET ${setClause} WHERE id = ?`, [...Object.values(fields), Number(id)]);
  saveSqliteDb();
  return getStoreDetails(id);
}

async function updateSubmissionStatus(id, status) {
  return updateStore(id, { status });
}

async function logEvent(storeId, event, payload) {
  if (USE_POSTGRES) {
    const pool = await getPgPool();
    await pool.query(
      "INSERT INTO integration_logs (store_id, event, payload) VALUES ($1, $2, $3)",
      [Number(storeId), event, JSON.stringify(payload || {})]
    );
    await pool.query("UPDATE stores SET updated_at = $1 WHERE id = $2", [nowIso(), Number(storeId)]);
    return;
  }

  const database = await getSqliteDb();
  sqliteRun(database, "INSERT INTO integration_logs (store_id, event, payload) VALUES (?, ?, ?)", [Number(storeId), event, JSON.stringify(payload || {})]);
  sqliteRun(database, "UPDATE stores SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(storeId)]);
  saveSqliteDb();
}

async function findClientUserByEmail(email) {
  const normalized = String(email || "").toLowerCase().trim();
  if (USE_POSTGRES) {
    const pool = await getPgPool();
    const res = await pool.query("SELECT * FROM client_users WHERE email = $1", [normalized]);
    return res.rows[0] || null;
  }
  const database = await getSqliteDb();
  return sqliteQueryOne(database, "SELECT * FROM client_users WHERE email = ?", [normalized]);
}

async function getClientUserSummaryByEmail(email) {
  const user = await findClientUserByEmail(email);
  if (!user) return null;
  return {
    id: Number(user.id),
    email: user.email,
    store_id: user.store_id,
    is_active: Number(user.is_active || 0) === 1,
    created_at: user.created_at,
  };
}

async function createClientUser(email, passwordHash, store_id) {
  const normalized = String(email || "").toLowerCase().trim();
  if (USE_POSTGRES) {
    const pool = await getPgPool();
    const exists = await pool.query("SELECT id FROM client_users WHERE email = $1", [normalized]);
    if (exists.rows.length) return false;
    await pool.query("INSERT INTO client_users (email, password_hash, store_id) VALUES ($1, $2, $3)", [normalized, passwordHash, store_id]);
    return true;
  }
  const database = await getSqliteDb();
  const exists = sqliteQueryOne(database, "SELECT id FROM client_users WHERE email = ?", [normalized]);
  if (exists) return false;
  sqliteRun(database, "INSERT INTO client_users (email, password_hash, store_id) VALUES (?, ?, ?)", [normalized, passwordHash, store_id]);
  saveSqliteDb();
  return true;
}

async function updateClientPasswordHash(email, passwordHash) {
  const normalized = String(email || "").toLowerCase().trim();
  if (USE_POSTGRES) {
    const pool = await getPgPool();
    await pool.query("UPDATE client_users SET password_hash = $1 WHERE email = $2", [passwordHash, normalized]);
    return;
  }
  const database = await getSqliteDb();
  sqliteRun(database, "UPDATE client_users SET password_hash = ? WHERE email = ?", [passwordHash, normalized]);
  saveSqliteDb();
}

module.exports = {
  initDb,
  createSubmission,
  getSubmissionById,
  listStores,
  getStoreDetails,
  getDashboardSummary,
  updateStore,
  updateSubmissionStatus,
  logEvent,
  findClientUserByEmail,
  getClientUserSummaryByEmail,
  createClientUser,
  updateClientPasswordHash,
  usePostgres: USE_POSTGRES,
};

initDb().catch(console.error);
