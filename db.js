require("dotenv").config();
const path = require("path");
const fs = require("fs");

let db;
const DB_PATH = path.join(__dirname, "agentcommerce.db");

const PLAN_CONFIG = {
  starter: { price: 19, msgLimit: 5000 },
  pro: { price: 29, msgLimit: 13000 },
  enterprise: { price: 49, msgLimit: 999999 },
};

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

async function getDb() {
  if (db) return db;
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function run(database, sql, params = []) {
  database.run(sql, params);
}

function queryAll(database, sql, params = []) {
  const stmt = database.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(database, sql, params = []) {
  return queryAll(database, sql, params)[0] || null;
}

function buildStoreLookupClause(idOrIdentifier) {
  const raw = String(idOrIdentifier || "").trim();
  const numeric = Number(raw);
  if (raw && !Number.isNaN(numeric) && /^\d+$/.test(raw)) {
    return { sql: "id = ?", params: [numeric] };
  }
  return { sql: "store_identifier = ?", params: [raw] };
}

function getExistingColumns(database, tableName) {
  return queryAll(database, `PRAGMA table_info(${tableName})`).map((col) => col.name);
}

function applyStoreMigrations(database) {
  const existingColumns = new Set(getExistingColumns(database, "stores"));
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
    if (!existingColumns.has(name)) {
      run(database, `ALTER TABLE stores ADD COLUMN ${name} ${definition}`);
    }
  }
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

async function initDb() {
  const database = await getDb();
  run(database, `
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
  run(database, `
    CREATE TABLE IF NOT EXISTS integration_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER,
      event TEXT NOT NULL,
      payload TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  applyStoreMigrations(database);

  run(database, "UPDATE stores SET store_identifier = COALESCE(store_identifier, '') WHERE store_identifier IS NULL");
  run(database, "UPDATE stores SET updated_at = COALESCE(updated_at, created_at)");
  run(database, "UPDATE stores SET plan = COALESCE(plan, 'starter')");
  run(database, "UPDATE stores SET plan_price = CASE plan WHEN 'pro' THEN 29 WHEN 'enterprise' THEN 49 ELSE 19 END");
  run(database, "UPDATE stores SET payment_amount = CASE WHEN payment_amount IS NULL OR payment_amount = 0 THEN plan_price ELSE payment_amount END");
  run(database, "UPDATE stores SET msg_limit = CASE plan WHEN 'pro' THEN 13000 WHEN 'enterprise' THEN 999999 ELSE 5000 END WHERE msg_limit IS NULL OR msg_limit = 0");

  const missingIdentifiers = queryAll(database, "SELECT id FROM stores WHERE store_identifier IS NULL OR store_identifier = ''");
  for (const row of missingIdentifiers) {
    run(database, "UPDATE stores SET store_identifier = ? WHERE id = ?", [formatStoreIdentifier(row.id), row.id]);
  }

  saveDb();
  console.log("Database schema ready");
}

async function createSubmission({
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
}) {
  const database = await getDb();
  const planMeta = getPlanMeta(plan);

  run(
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
      storeUrl,
      platform,
      storeName,
      contactEmail,
      credentials,
      categories,
      deliveryMethods,
      returnPolicy,
      faqs,
      notes,
      "pending",
      plan,
      planMeta.price,
      planMeta.msgLimit,
      0,
      "pending",
      planMeta.price,
      "USD",
      "new",
      "not_started",
      "not_installed",
      "medium",
      `${storeName} Assistant`,
      "#7c3aed",
      `Hi! Welcome to ${storeName}.`,
      "",
      "",
      qnaCount,
      fullDetails,
      storeAnswers,
      billingCycle,
      loginEmail,
      phoneNumber,
      hasPhysicalStore ? 1 : 0,
      storeAddress,
    ]
  );

  const result = queryOne(database, "SELECT last_insert_rowid() AS id");
  const id = Number(result.id);
  run(database, "UPDATE stores SET store_identifier = ? WHERE id = ?", [formatStoreIdentifier(id), id]);
  saveDb();

  return { id, storeIdentifier: formatStoreIdentifier(id), planPrice: planMeta.price, msgLimit: planMeta.msgLimit };
}

async function getSubmissionById(id) {
  const database = await getDb();
  const lookup = buildStoreLookupClause(id);
  return hydrateStore(queryOne(database, `SELECT * FROM stores WHERE ${lookup.sql}`, lookup.params));
}

async function listStores(filters = {}) {
  const database = await getDb();
  const clauses = [];
  const params = [];

  if (filters.status && filters.status !== "all") {
    clauses.push("status = ?");
    params.push(filters.status);
  }

  if (filters.plan && filters.plan !== "all") {
    clauses.push("plan = ?");
    params.push(filters.plan);
  }

  if (filters.platform && filters.platform !== "all") {
    clauses.push("platform = ?");
    params.push(filters.platform);
  }

  if (filters.paymentStatus && filters.paymentStatus !== "all") {
    clauses.push("payment_status = ?");
    params.push(filters.paymentStatus);
  }

  if (filters.setupStatus && filters.setupStatus !== "all") {
    clauses.push("setup_status = ?");
    params.push(filters.setupStatus);
  }

  if (filters.search) {
    clauses.push("(store_name LIKE ? OR store_url LIKE ? OR contact_email LIKE ? OR store_identifier LIKE ?)");
    const like = `%${filters.search}%`;
    params.push(like, like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = queryAll(
    database,
    `SELECT * FROM stores ${where} ORDER BY
      CASE status
        WHEN 'pending' THEN 0
        WHEN 'review' THEN 1
        WHEN 'active' THEN 2
        WHEN 'paused' THEN 3
        WHEN 'archived' THEN 4
        ELSE 5
      END,
      datetime(created_at) DESC`,
    params
  );

  return rows.map(hydrateStore);
}

async function getStoreDetails(id) {
  const database = await getDb();
  const lookup = buildStoreLookupClause(id);
  const rawStore = queryOne(database, `SELECT * FROM stores WHERE ${lookup.sql}`, lookup.params);
  const store = hydrateStore(rawStore);
  if (!store) return null;

  const logs = queryAll(
    database,
    "SELECT * FROM integration_logs WHERE store_id = ? ORDER BY datetime(created_at) DESC LIMIT 40",
    [Number(store.id)]
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
  const database = await getDb();
  const current = queryOne(database, "SELECT * FROM stores WHERE id = ?", [Number(id)]);
  if (!current) return null;

  const nextPlan = updates.plan || current.plan || "starter";
  const planMeta = getPlanMeta(nextPlan);

  const fields = {
    store_name: updates.storeName ?? current.store_name,
    contact_email: updates.contactEmail ?? current.contact_email,
    status: updates.status ?? current.status,
    plan: nextPlan,
    plan_price: updates.planPrice ?? (updates.plan ? planMeta.price : current.plan_price),
    msg_limit: updates.msgLimit ?? (updates.plan ? planMeta.msgLimit : current.msg_limit),
    msg_count: updates.msgCount ?? current.msg_count,
    payment_status: updates.paymentStatus ?? current.payment_status,
    payment_amount: updates.paymentAmount ?? (updates.plan ? planMeta.price : current.payment_amount),
    setup_status: updates.setupStatus ?? current.setup_status,
    workflow_status: updates.workflowStatus ?? current.workflow_status,
    widget_status: updates.widgetStatus ?? current.widget_status,
    priority: updates.priority ?? current.priority,
    webhook_url: updates.webhookUrl ?? current.webhook_url,
    agent_name: updates.agentName ?? current.agent_name,
    accent_color: updates.accentColor ?? current.accent_color,
    welcome_message: updates.welcomeMessage ?? current.welcome_message,
    internal_notes: updates.internalNotes ?? current.internal_notes,
    last_active_at: updates.lastActiveAt ?? current.last_active_at,
    last_synced_at: updates.lastSyncedAt ?? current.last_synced_at,
    updated_at: new Date().toISOString(),
  };

  const setClause = Object.keys(fields).map((key) => `${key} = ?`).join(", ");
  const values = [...Object.values(fields), Number(id)];
  run(database, `UPDATE stores SET ${setClause} WHERE id = ?`, values);
  saveDb();

  return getStoreDetails(id);
}

async function updateSubmissionStatus(id, status) {
  return updateStore(id, { status });
}

async function logEvent(storeId, event, payload) {
  const database = await getDb();
  run(
    database,
    `INSERT INTO integration_logs (store_id, event, payload) VALUES (?, ?, ?)`,
    [Number(storeId), event, JSON.stringify(payload || {})]
  );
  run(database, "UPDATE stores SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(storeId)]);
  saveDb();
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
};

initDb().catch(console.error);
