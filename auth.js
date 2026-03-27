require("dotenv").config();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");

const JWT_SECRET = process.env.JWT_SECRET || "agentcomerce_jwt_secret_2024";
const DB_PATH = path.join(__dirname, "agentcommerce.db");

let _db = null;

async function getAuthDb() {
  if (_db) return _db;
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }
  return _db;
}

function saveAuthDb() {
  if (!_db) return;
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

async function ensureUsersTable() {
  const db = await getAuthDb();
  db.run(`CREATE TABLE IF NOT EXISTS client_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    store_id TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  saveAuthDb();
}

ensureUsersTable().catch(console.error);

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    req.user = jwt.verify(header.split(" ")[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
}

function registerRoutes(app, db) {

  // POST /api/auth/create-client
  app.post("/api/auth/create-client", async (req, res) => {
    const { email, password, store_id } = req.body;
    if (!email || !password || !store_id) {
      return res.status(400).json({ message: "email, password and store_id are required" });
    }
    try {
      const database = await getAuthDb();
      await ensureUsersTable();

      const stmt = database.prepare("SELECT id FROM client_users WHERE email = ?");
      stmt.bind([email.toLowerCase().trim()]);
      let exists = false;
      if (stmt.step()) exists = true;
      stmt.free();

      if (exists) return res.status(400).json({ message: "Email already registered" });

      const hash = await bcrypt.hash(password, 10);
      database.run(
        "INSERT INTO client_users (email, password_hash, store_id) VALUES (?, ?, ?)",
        [email.toLowerCase().trim(), hash, store_id]
      );
      saveAuthDb();

      res.status(201).json({ success: true, message: "Client account created successfully" });
    } catch (err) {
      console.error("Create client error:", err);
      res.status(500).json({ message: "Failed to create account: " + err.message });
    }
  });

  // POST /api/auth/login
  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }
    try {
      const database = await getAuthDb();

      const stmt = database.prepare("SELECT * FROM client_users WHERE email = ? AND is_active = 1");
      stmt.bind([email.toLowerCase().trim()]);
      let user = null;
      if (stmt.step()) user = stmt.getAsObject();
      stmt.free();

      if (!user) return res.status(401).json({ message: "Invalid email or password" });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ message: "Invalid email or password" });

      const token = jwt.sign(
        { id: user.id, email: user.email, store_id: user.store_id },
        JWT_SECRET,
        { expiresIn: "30d" }
      );

      res.json({
        token,
        user: { email: user.email, store_id: user.store_id }
      });
    } catch (err) {
      console.error("Login error:", err);
      res.status(500).json({ message: "Login failed: " + err.message });
    }
  });

  // GET /api/client/dashboard
  app.get("/api/client/dashboard", requireAuth, async (req, res) => {
    try {
      const store = await db.getStoreDetails(req.user.store_id).catch(() => null);
      res.json({
        success: true,
        store: store,
        user: { email: req.user.email, store_id: req.user.store_id }
      });
    } catch (err) {
      console.error("Dashboard error:", err);
      res.status(500).json({ message: "Failed to load dashboard" });
    }
  });

}

module.exports = { registerRoutes, requireAuth };
