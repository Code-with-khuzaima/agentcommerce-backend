require("dotenv").config();
const path = require("path");
const fs = require("fs");

let db;
const DB_PATH = path.join(__dirname, "agentcommerce.db");

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

async function initDb() {
  const database = await getDb();
  database.run(`
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
  database.run(`
    CREATE TABLE IF NOT EXISTS integration_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER,
      event TEXT NOT NULL,
      payload TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  saveDb();
  console.log("✅  Database schema ready");
}

async function createSubmission({
  storeUrl, platform, storeName, contactEmail,
  credentials, categories, deliveryMethods,
  returnPolicy, faqs, notes,
}) {
  const database = await getDb();
  database.run(
    `INSERT INTO stores
      (store_url, platform, store_name, contact_email, credentials,
       categories, delivery_methods, return_policy, faqs, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [storeUrl, platform, storeName, contactEmail, credentials,
     categories, deliveryMethods, returnPolicy, faqs, notes]
  );
  const result = database.exec("SELECT last_insert_rowid() as id");
  saveDb();
  const id = result[0].values[0][0];
  return { id };
}

async function getSubmissionById(id) {
  const database = await getDb();
  const result = database.exec(
    `SELECT * FROM stores WHERE id = ${parseInt(id)}`
  );
  if (!result.length) return null;
  const cols = result[0].columns;
  const vals = result[0].values[0];
  return Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
}

async function updateSubmissionStatus(id, status) {
  const database = await getDb();
  database.run(
    `UPDATE stores SET status = ? WHERE id = ?`,
    [status, parseInt(id)]
  );
  saveDb();
}

async function logEvent(storeId, event, payload) {
  const database = await getDb();
  database.run(
    `INSERT INTO integration_logs (store_id, event, payload) VALUES (?, ?, ?)`,
    [parseInt(storeId), event, JSON.stringify(payload)]
  );
  saveDb();
}

module.exports = {
  initDb,
  createSubmission,
  getSubmissionById,
  updateSubmissionStatus,
  logEvent,
};

initDb().catch(console.error);
