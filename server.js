require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { body, validationResult } = require("express-validator");

const db = require("./db");
const { encrypt } = require("./crypto");
const { sendAdminEmail, sendConfirmationEmail } = require("./email");
const { validateShopify, validateWooCommerce } = require("./platformValidator");

const app = express();
const PORT = process.env.PORT || 4000;

const ADMIN_STATUSES = ["pending", "review", "active", "paused", "archived"];
const PAYMENT_STATUSES = ["pending", "paid", "overdue", "refunded"];
const SETUP_STATUSES = ["new", "credentials_review", "workflow_building", "widget_installing", "qa_testing", "live"];
const WORKFLOW_STATUSES = ["not_started", "draft", "ready", "live", "issue"];
const WIDGET_STATUSES = ["not_installed", "ready", "live", "paused"];
const PRIORITIES = ["low", "medium", "high", "urgent"];

app.use(helmet());
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:3000,https://agentcommerce-frontend-git-master-code-with-khuzaimas-projects.vercel.app,https://agentcommerce-frontend.vercel.app")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
}));
app.use(express.json({ limit: "64kb" }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { message: "Too many requests, please try again later." },
});
app.use("/api/", limiter);

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ message: "Validation failed", errors: errors.array() });
  }
  next();
}

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

app.get("/api/admin/dashboard", async (req, res) => {
  try {
    const filters = {
      search: req.query.search || "",
      status: req.query.status || "all",
      plan: req.query.plan || "all",
      platform: req.query.platform || "all",
      paymentStatus: req.query.paymentStatus || "all",
      setupStatus: req.query.setupStatus || "all",
    };

    const [summary, stores] = await Promise.all([
      db.getDashboardSummary(),
      db.listStores(filters),
    ]);

    res.json({ success: true, summary, stores, filters });
  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).json({ message: "Failed to load dashboard data." });
  }
});

app.get("/api/admin/stores/:id", async (req, res) => {
  try {
    const store = await db.getStoreDetails(req.params.id);
    if (!store) {
      return res.status(404).json({ message: "Store not found." });
    }
    res.json({ success: true, store });
  } catch (err) {
    console.error("Admin store detail error:", err);
    res.status(500).json({ message: "Failed to load store details." });
  }
});

app.patch(
  "/api/admin/stores/:id",
  [
    body("status").optional().isIn(ADMIN_STATUSES),
    body("plan").optional().isIn(["starter", "pro", "enterprise"]),
    body("paymentStatus").optional().isIn(PAYMENT_STATUSES),
    body("setupStatus").optional().isIn(SETUP_STATUSES),
    body("workflowStatus").optional().isIn(WORKFLOW_STATUSES),
    body("widgetStatus").optional().isIn(WIDGET_STATUSES),
    body("priority").optional().isIn(PRIORITIES),
    body("msgCount").optional().isInt({ min: 0 }),
    body("msgLimit").optional().isInt({ min: 0 }),
    body("paymentAmount").optional().isInt({ min: 0 }),
    body("webhookUrl").optional().isString().isLength({ max: 1000 }),
    body("agentName").optional().isString().isLength({ max: 200 }),
    body("accentColor").optional().matches(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
    body("welcomeMessage").optional().isString().isLength({ max: 300 }),
    body("internalNotes").optional().isString().isLength({ max: 6000 }),
  ],
  validate,
  async (req, res) => {
    try {
      const store = await db.updateStore(req.params.id, req.body);
      if (!store) {
        return res.status(404).json({ message: "Store not found." });
      }

      await db.logEvent(req.params.id, "store_updated", {
        fields: Object.keys(req.body),
        at: new Date().toISOString(),
      });

      res.json({ success: true, store });
    } catch (err) {
      console.error("Admin store update error:", err);
      res.status(500).json({ message: "Failed to update store." });
    }
  }
);

app.post(
  "/api/admin/stores/:id/logs",
  [body("event").notEmpty().isString(), body("payload").optional().isObject()],
  validate,
  async (req, res) => {
    try {
      const store = await db.getSubmissionById(req.params.id);
      if (!store) {
        return res.status(404).json({ message: "Store not found." });
      }
      await db.logEvent(req.params.id, req.body.event, req.body.payload || {});
      const updated = await db.getStoreDetails(req.params.id);
      res.status(201).json({ success: true, store: updated });
    } catch (err) {
      console.error("Admin log error:", err);
      res.status(500).json({ message: "Failed to save log event." });
    }
  }
);

app.post(
  "/api/validate-credentials",
  [
    body("platform").isIn(["shopify", "woocommerce"]),
    body("storeUrl").isURL({ require_protocol: true }),
  ],
  validate,
  async (req, res) => {
    const { platform, storeUrl, apiKey, accessToken, consumerKey, consumerSecret } = req.body;

    try {
      let result;
      if (platform === "shopify") {
        result = await validateShopify({ storeUrl, apiKey, accessToken });
      } else {
        result = await validateWooCommerce({ storeUrl, consumerKey, consumerSecret });
      }
      res.json({ success: true, shopInfo: result });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message || "Invalid credentials" });
    }
  }
);

app.post(
  "/api/submit",
  [
    body("storeUrl").isURL({ require_protocol: true }).trim().escape(),
    body("platform").isIn(["shopify", "woocommerce"]),
    body("plan").optional().isIn(["starter", "pro", "enterprise"]),
    body("storeName").notEmpty().trim().escape().isLength({ max: 200 }),
    body("contactEmail").isEmail().normalizeEmail(),
    body("categories").optional().isArray(),
    body("deliveryMethods").optional().isArray(),
    body("returnPolicy").optional().trim().isLength({ max: 2000 }),
    body("faqs").optional().trim().isLength({ max: 5000 }),
    body("notes").optional().trim().isLength({ max: 2000 }),
    body("qnaPairs").optional().isArray(),
    body("storeAnswers").optional().isObject(),
    body("fullDetails").optional().isString().isLength({ max: 12000 }),
  ],
  validate,
  async (req, res) => {
    const {
      plan,
      storeUrl,
      platform,
      storeName,
      contactEmail,
      apiKey,
      accessToken,
      consumerKey,
      consumerSecret,
      categories,
      deliveryMethods,
      returnPolicy,
      faqs,
      notes,
      qnaPairs,
      storeAnswers,
      fullDetails,
    } = req.body;

    try {
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
        contactEmail,
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

      Promise.all([
        sendAdminEmail({ submission: { ...req.body, id: submission.id } }),
        sendConfirmationEmail({ to: contactEmail, storeName }),
      ]).catch((err) => console.error("Email error:", err));

      res.status(201).json({
        success: true,
        submissionId: submission.id,
        storeId: submission.storeIdentifier,
        planPrice: submission.planPrice,
        msgLimit: submission.msgLimit,
        message: "Submission received. Our team will contact you within 1-2 business days.",
      });
    } catch (err) {
      console.error("Submit error:", err);
      res.status(500).json({ message: "Failed to process submission. Please try again." });
    }
  }
);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`AgentCommerce API running on http://localhost:${PORT}`);
});

module.exports = app;

