// ============================================================
// AgentCommerce Backend — server.js
// Node.js + Express
// ============================================================

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

// ── Middleware ───────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:3000" }));
app.use(express.json({ limit: "10kb" }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 30,
  message: { message: "Too many requests, please try again later." },
});
app.use("/api/", limiter);

// ── Validation middleware ────────────────────────────────────
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ message: "Validation failed", errors: errors.array() });
  }
  next();
}

// ── Health check ─────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// ── Validate credentials (test API connection) ───────────────
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

// ── Submit onboarding form ────────────────────────────────────
app.post(
  "/api/submit",
  [
    body("storeUrl").isURL({ require_protocol: true }).trim().escape(),
    body("platform").isIn(["shopify", "woocommerce"]),
    body("storeName").notEmpty().trim().escape().isLength({ max: 200 }),
    body("contactEmail").isEmail().normalizeEmail(),
    body("categories").optional().isArray(),
    body("deliveryMethods").optional().isArray(),
    body("returnPolicy").optional().trim().isLength({ max: 2000 }),
    body("faqs").optional().trim().isLength({ max: 5000 }),
    body("notes").optional().trim().isLength({ max: 2000 }),
  ],
  validate,
  async (req, res) => {
    const {
      storeUrl, platform, storeName, contactEmail,
      apiKey, accessToken, consumerKey, consumerSecret,
      categories, deliveryMethods, returnPolicy, faqs, notes,
    } = req.body;

    try {
      // Encrypt sensitive credentials before storing
      const encryptedCredentials = {};
      if (platform === "shopify") {
        encryptedCredentials.apiKey        = apiKey        ? encrypt(apiKey)        : null;
        encryptedCredentials.accessToken   = accessToken   ? encrypt(accessToken)   : null;
      } else {
        encryptedCredentials.consumerKey    = consumerKey    ? encrypt(consumerKey)    : null;
        encryptedCredentials.consumerSecret = consumerSecret ? encrypt(consumerSecret) : null;
      }

      // Insert into database
      const submission = await db.createSubmission({
        storeUrl,
        platform,
        storeName,
        contactEmail,
        credentials: JSON.stringify(encryptedCredentials),
        categories: JSON.stringify(categories || []),
        deliveryMethods: JSON.stringify(deliveryMethods || []),
        returnPolicy: returnPolicy || "",
        faqs: faqs || "",
        notes: notes || "",
      });

      // Send emails (fire-and-forget, don't block the response)
      Promise.all([
        sendAdminEmail({ submission: { ...req.body, id: submission.id } }),
        sendConfirmationEmail({ to: contactEmail, storeName }),
      ]).catch(err => console.error("Email error:", err));

      res.status(201).json({
        success: true,
        submissionId: submission.id,
        message: "Submission received. Our team will contact you within 1–2 business days.",
      });
    } catch (err) {
      console.error("Submit error:", err);
      res.status(500).json({ message: "Failed to process submission. Please try again." });
    }
  }
);

// ── Global error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: "Internal server error" });
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅  AgentCommerce API running on http://localhost:${PORT}`));

module.exports = app;
