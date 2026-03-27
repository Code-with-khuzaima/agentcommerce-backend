// server.js
require("dotenv").config();
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");
const cors = require("cors");

const app = express();

app.use(cors()); // 🔥 ADD THIS LINE
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "agentcomerce_jwt_secret_2024";
const DB_PATH = path.join(__dirname, "agentcommerce.db");

let _db = null;

// Initialize SQL.js
async function getAuthDb() {
  if (_db) return _db;

  try {
    const initSqlJs = require("sql.js");
    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
      try {
        const fileBuffer = fs.readFileSync(DB_PATH);
        _db = new SQL.Database(fileBuffer);
        console.log("Database loaded from file:", DB_PATH);
      } catch (err) {
        console.error("Failed to read DB file, creating new DB:", err);
        _db = new SQL.Database();
      }
    } else {
      console.log("DB file not found, creating new DB");
      _db = new SQL.Database();
    }
    return _db;
  } catch (err) {
    console.error("Error initializing SQL.js:", err);
    throw err;
  }
}

// Save in-memory DB to file
function saveAuthDb() {
  if (!_db) return;
  try {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    console.log("Database saved to file");
  } catch (err) {
    console.error("Failed to save DB:", err);
  }
}

// Ensure table exists
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
  console.log("client_users table ensured");
}

// JWT authentication middleware
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    req.user = jwt.verify(header.split(" ")[1], JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

// Routes
async function registerRoutes(app) {
  await ensureUsersTable();

  // Create client
  app.post("/api/auth/create-client", async (req, res) => {
    const { email, password, store_id } = req.body;
    console.log("Create client request:", req.body);

    if (!email || !password || !store_id) {
      return res.status(400).json({ message: "email, password and store_id are required" });
    }

    try {
      const db = await getAuthDb();

      const stmt = db.prepare("SELECT id FROM client_users WHERE email = ?");
      stmt.bind([email.toLowerCase().trim()]);
      let exists = stmt.step();
      stmt.free();

      if (exists) return res.status(400).json({ message: "Email already registered" });

      const hash = await bcrypt.hash(password, 10);
      db.run(
        "INSERT INTO client_users (email, password_hash, store_id) VALUES (?, ?, ?)",
        [email.toLowerCase().trim(), hash, store_id]
      );
      saveAuthDb();
      console.log("Client account created successfully:", email);

      res.status(201).json({ success: true, message: "Client account created successfully" });
    } catch (err) {
      console.error("Error creating client:", err);
      res.status(500).json({ message: "Failed to create account: " + err.message });
    }
  });

  // Login
  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    console.log("Login request:", req.body);

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    try {
      const db = await getAuthDb();

      const stmt = db.prepare("SELECT * FROM client_users WHERE email = ? AND is_active = 1");
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

      res.json({ token, user: { email: user.email, store_id: user.store_id } });
    } catch (err) {
      console.error("Login error:", err);
      res.status(500).json({ message: "Login failed: " + err.message });
    }
  });

  // Protected dashboard example
  app.get("/api/client/dashboard", requireAuth, async (req, res) => {
    res.json({
      success: true,
      user: { email: req.user.email, store_id: req.user.store_id }
    });
  });
}

// Start server
const PORT = process.env.PORT || 4000;
registerRoutes(app).then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error("Failed to register routes:", err);
});

