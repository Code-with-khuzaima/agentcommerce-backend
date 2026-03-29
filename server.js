require("dotenv").config();
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { body, validationResult } = require("express-validator");

const db = require("./db");
const { encrypt } = require("./crypto");
const { sendAdminEmail, sendConfirmationEmail, sendPasswordResetEmail } = require("./email");
const { validateShopify, validateWooCommerce } = require("./platformValidator");

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "agentcomerce_jwt_secret_2024";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "agentcommerce_admin_2024";
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || JWT_SECRET;
const DB_PATH = path.join(__dirname, "agentcommerce.db");

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",").map((origin) => origin.trim()).filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;

  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname.endsWith(".vercel.app") || hostname.endsWith(".railway.app");
  } catch {
    return false;
  }
}

app.use(cors({
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
}));
app.use(helmet());
app.use(express.json({ limit: "64kb" }));
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }));

const ADMIN_STATUSES = ["pending", "review", "active", "paused", "archived"];
const PAYMENT_STATUSES = ["pending", "paid", "overdue", "refunded"];
const SETUP_STATUSES = ["new", "credentials_review", "workflow_building", "widget_installing", "qa_testing", "live"];
const WORKFLOW_STATUSES = ["not_started", "draft", "ready", "live", "issue"];
const WIDGET_STATUSES = ["not_installed", "ready", "live", "paused"];
const PRIORITIES = ["low", "medium", "high", "urgent"];

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ message: "Validation failed", errors: errors.array() });
  next();
}

let _authDb = null;

async function getAuthDb() {
  if (_authDb) return _authDb;
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    _authDb = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _authDb = new SQL.Database();
  }
  return _authDb;
}

function saveAuthDb() {
  if (!_authDb) return;
  fs.writeFileSync(DB_PATH, Buffer.from(_authDb.export()));
}

async function ensureUsersTable() {
  const database = await getAuthDb();
  database.run(`CREATE TABLE IF NOT EXISTS client_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    store_id TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  saveAuthDb();
}

async function findClientUserByEmail(email) {
  const database = await getAuthDb();
  const stmt = database.prepare("SELECT * FROM client_users WHERE email = ?");
  stmt.bind([String(email || "").toLowerCase().trim()]);
  let user = null;
  if (stmt.step()) user = stmt.getAsObject();
  stmt.free();
  return user;
}

async function createClientUser(email, password, store_id) {
  const database = await getAuthDb();
  const stmt = database.prepare("SELECT id FROM client_users WHERE email = ?");
  stmt.bind([email.toLowerCase()]);
  const exists = stmt.step();
  stmt.free();
  if (exists) return false;
  const hash = await bcrypt.hash(password, 10);
  database.run("INSERT INTO client_users (email, password_hash, store_id) VALUES (?, ?, ?)",
    [email.toLowerCase(), hash, store_id]);
  saveAuthDb();
  return true;
}

async function updateClientPassword(email, password) {
  const database = await getAuthDb();
  const hash = await bcrypt.hash(password, 10);
  database.run("UPDATE client_users SET password_hash = ? WHERE email = ?", [hash, String(email || "").toLowerCase().trim()]);
  saveAuthDb();
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ message: "Unauthorized" });
  try {
    req.user = jwt.verify(header.split(" ")[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

function verifySecret(candidate, actual) {
  const candidateBuffer = Buffer.from(String(candidate || ""), "utf8");
  const actualBuffer = Buffer.from(String(actual || ""), "utf8");
  if (candidateBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(candidateBuffer, actualBuffer);
}

function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ message: "Admin authorization required." });
  try {
    const token = header.split(" ")[1];
    const payload = jwt.verify(token, ADMIN_SESSION_SECRET);
    if (payload.role !== "admin") return res.status(403).json({ message: "Admin access denied." });
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ message: "Invalid admin session." });
  }
}

ensureUsersTable().catch(console.error);

app.get("/api/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

app.post("/api/auth/create-client", async (req, res) => {
  const { email, password, store_id } = req.body;
  if (!email || !password || !store_id) {
    return res.status(400).json({ message: "email, password and store_id are required" });
  }

  try {
    const created = await createClientUser(email, password, store_id);
    if (!created) return res.status(400).json({ message: "Email already registered" });
    res.status(201).json({ success: true, message: "Client account created successfully" });
  } catch (err) {
    console.error("Create client error:", err);
    res.status(500).json({ message: `Failed to create account: ${err.message}` });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "Email and password required" });

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

    res.json({ token, user: { email: user.email, store_id: user.store_id } });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: `Login failed: ${err.message}` });
  }
});

app.post("/api/admin/login", [
  body("password").isString().trim().notEmpty(),
], validate, async (req, res) => {
  try {
    const { password } = req.body;
    if (!verifySecret(password, ADMIN_PASSWORD)) {
      return res.status(401).json({ message: "Incorrect admin password." });
    }

    const token = jwt.sign({ role: "admin" }, ADMIN_SESSION_SECRET, { expiresIn: "12h" });
    res.json({ success: true, token });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ message: "Admin login failed." });
  }
});

app.get("/api/client/dashboard", requireAuth, async (req, res) => {
  try {
    const store = await db.getStoreDetails(req.user.store_id).catch(() => null);
    res.json({ success: true, store, user: { email: req.user.email, store_id: req.user.store_id } });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).json({ message: "Failed to load dashboard" });
  }
});

app.get("/api/admin/dashboard", requireAdminAuth, async (req, res) => {
  try {
    const filters = {
      search: req.query.search || "",
      status: req.query.status || "all",
      plan: req.query.plan || "all",
      platform: req.query.platform || "all",
      paymentStatus: req.query.paymentStatus || "all",
      setupStatus: req.query.setupStatus || "all",
    };
    const [summary, stores] = await Promise.all([db.getDashboardSummary(), db.listStores(filters)]);
    res.json({ success: true, summary, stores, filters });
  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).json({ message: "Failed to load dashboard data." });
  }
});

app.get("/api/admin/stores/:id", requireAdminAuth, async (req, res) => {
  try {
    const store = await db.getStoreDetails(req.params.id);
    if (!store) return res.status(404).json({ message: "Store not found." });
    res.json({ success: true, store });
  } catch (err) {
    console.error("Admin store detail error:", err);
    res.status(500).json({ message: "Failed to load store details." });
  }
});

app.patch("/api/admin/stores/:id", [
  body("status").optional().isIn(ADMIN_STATUSES),
  body("plan").optional().isIn(["starter", "pro", "enterprise"]),
  body("paymentStatus").optional().isIn(PAYMENT_STATUSES),
  body("setupStatus").optional().isIn(SETUP_STATUSES),
  body("workflowStatus").optional().isIn(WORKFLOW_STATUSES),
  body("widgetStatus").optional().isIn(WIDGET_STATUSES),
  body("priority").optional().isIn(PRIORITIES),
  body("msgCount").optional().isInt({ min: 0 }),
  body("msgLimit").optional().isInt({ min: 0 }),
  body("webhookUrl").optional().isString().isLength({ max: 1000 }),
  body("agentName").optional().isString().isLength({ max: 200 }),
  body("accentColor").optional().matches(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
  body("welcomeMessage").optional().isString().isLength({ max: 300 }),
  body("internalNotes").optional().isString().isLength({ max: 6000 }),
], validate, requireAdminAuth, async (req, res) => {
  try {
    const store = await db.updateStore(req.params.id, req.body);
    if (!store) return res.status(404).json({ message: "Store not found." });
    await db.logEvent(req.params.id, "store_updated", { fields: Object.keys(req.body), at: new Date().toISOString() });
    res.json({ success: true, store });
  } catch (err) {
    console.error("Admin store update error:", err);
    res.status(500).json({ message: "Failed to update store." });
  }
});

app.post("/api/admin/stores/:id/logs", [
  body("event").notEmpty().isString(),
  body("payload").optional().isObject(),
], validate, requireAdminAuth, async (req, res) => {
  try {
    const store = await db.getSubmissionById(req.params.id);
    if (!store) return res.status(404).json({ message: "Store not found." });
    await db.logEvent(req.params.id, req.body.event, req.body.payload || {});
    const updated = await db.getStoreDetails(req.params.id);
    res.status(201).json({ success: true, store: updated });
  } catch (err) {
    console.error("Admin log error:", err);
    res.status(500).json({ message: "Failed to save log." });
  }
});

app.post("/api/validate-credentials", [
  body("platform").isIn(["shopify", "woocommerce"]),
  body("storeUrl").isURL({ require_protocol: true }),
], validate, async (req, res) => {
  const { platform, storeUrl, apiKey, accessToken, consumerKey, consumerSecret } = req.body;
  try {
    let result;
    if (platform === "shopify") result = await validateShopify({ storeUrl, apiKey, accessToken });
    else result = await validateWooCommerce({ storeUrl, consumerKey, consumerSecret });
    res.json({ success: true, shopInfo: result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || "Invalid credentials" });
  }
});

app.post("/api/submit", [
  body("storeUrl").isURL({ require_protocol: true }).trim().escape(),
  body("platform").isIn(["shopify", "woocommerce"]),
  body("plan").optional().isIn(["starter", "pro", "enterprise"]),
  body("billingCycle").optional().isIn(["monthly", "yearly"]),
  body("storeName").notEmpty().trim().escape().isLength({ max: 200 }),
  body("storeContactEmail").isEmail().normalizeEmail(),
  body("loginEmail").isEmail().normalizeEmail(),
  body("phoneNumber").isString().trim().isLength({ min: 3, max: 100 }),
  body("storeAddress").optional().isString().trim().isLength({ max: 500 }),
  body("accountPassword").isString().isLength({ min: 8, max: 200 }),
  body("categories").optional().isArray(),
  body("deliveryMethods").optional().isArray(),
  body("returnPolicy").optional().trim().isLength({ max: 2000 }),
  body("faqs").optional().trim().isLength({ max: 5000 }),
  body("notes").optional().trim().isLength({ max: 2000 }),
  body("qnaPairs").optional().isArray(),
  body("storeAnswers").optional().isObject(),
  body("fullDetails").optional().isString().isLength({ max: 12000 }),
], validate, async (req, res) => {
  const {
    plan, billingCycle, storeUrl, platform, storeName, storeContactEmail, loginEmail, phoneNumber, hasPhysicalStore, storeAddress, accountPassword,
    apiKey, accessToken, consumerKey, consumerSecret,
    categories, deliveryMethods, returnPolicy, faqs, notes,
    qnaPairs, storeAnswers, fullDetails,
  } = req.body;

  try {
    const existingClient = await findClientUserByEmail(loginEmail);
    if (existingClient) {
      return res.status(409).json({ message: "This email is already registered. Please log in instead." });
    }

    const encryptedCredentials = {};
    if (platform === "shopify") {
      encryptedCredentials.apiKey = apiKey ? encrypt(apiKey) : null;
      encryptedCredentials.accessToken = accessToken ? encrypt(accessToken) : null;
    } else {
      encryptedCredentials.consumerKey = consumerKey ? encrypt(consumerKey) : null;
      encryptedCredentials.consumerSecret = consumerSecret ? encrypt(consumerSecret) : null;
    }

    const submission = await db.createSubmission({
      storeUrl,
      platform,
      storeName,
      contactEmail: storeContactEmail,
      loginEmail,
      phoneNumber,
      hasPhysicalStore: Boolean(hasPhysicalStore),
      storeAddress: storeAddress || "",
      billingCycle: billingCycle || "monthly",
      plan: plan || "starter",
      credentials: JSON.stringify(encryptedCredentials),
      categories: JSON.stringify(categories || []),
      deliveryMethods: JSON.stringify(deliveryMethods || []),
      returnPolicy: returnPolicy || "",
      faqs: faqs || "",
      notes: notes || "",
      storeAnswers: JSON.stringify(storeAnswers || {}),
      fullDetails: fullDetails || "",
      qnaCount: Array.isArray(qnaPairs) ? qnaPairs.length : 0,
    });

    await db.logEvent(submission.id, "submission_created", {
      storeIdentifier: submission.storeIdentifier,
      plan: plan || "starter",
      platform,
    });

    const created = await createClientUser(loginEmail, accountPassword, submission.storeIdentifier);
    if (!created) {
      return res.status(409).json({ message: "This email is already registered. Please log in instead." });
    }

    Promise.all([
      sendAdminEmail({ submission: { ...req.body, id: submission.id } }),
      sendConfirmationEmail({
        to: loginEmail,
        storeName,
        loginEmail,
        loginPassword: "(the password the client chose during signup)",
        storeId: submission.storeIdentifier,
        loginUrl: "https://agentcommerce-frontend-git-master-code-with-khuzaimas-projects.vercel.app/login",
      }),
    ]).catch((err) => console.error("Email error:", err));

    res.status(201).json({
      success: true,
      submissionId: submission.id,
      storeId: submission.storeIdentifier,
      planPrice: submission.planPrice,
      msgLimit: submission.msgLimit,
      message: "Submission received. You can now log in with your email and password.",
      loginEmail,
    });
  } catch (err) {
    console.error("Submit error:", err);
    res.status(500).json({ message: "Failed to process submission. Please try again." });
  }
});

app.post("/api/auth/forgot-password", [
  body("email").isEmail().normalizeEmail(),
], validate, async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const user = await findClientUserByEmail(email);

    if (user) {
      const temporaryPassword = Math.random().toString(36).slice(-10) + "A1";
      await updateClientPassword(email, temporaryPassword);
      await sendPasswordResetEmail({ to: email, temporaryPassword });
    }

    res.json({ success: true, message: "If the email exists, a temporary password has been sent." });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ message: "Failed to process forgot password request." });
  }
});
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: "Internal server error" });
});

app.listen(PORT, () => console.log(`AgentCommerce API running on http://localhost:${PORT}`));
module.exports = app;

