// ============================================================
// platformValidator.js
// Tests API connectivity for Shopify and WooCommerce
// ============================================================

const https = require("https");
const http  = require("http");

/**
 * Generic HTTPS/HTTP request helper (no extra deps)
 */
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: 8000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try { body = JSON.parse(body); } catch {}
          resolve({ status: res.statusCode, body });
        });
      }
    );

    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.on("error", reject);
    req.end();
  });
}

// ── Shopify ───────────────────────────────────────────────────
async function validateShopify({ storeUrl, apiKey, accessToken }) {
  if (!storeUrl || !apiKey || !accessToken) {
    throw new Error("Missing Shopify credentials");
  }

  // Normalize URL
  const base = storeUrl.replace(/\/$/, "");
  const url  = `${base}/admin/api/2024-01/shop.json`;

  const { status, body } = await request(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  if (status === 401) throw new Error("Invalid Shopify credentials — check your Access Token");
  if (status === 404) throw new Error("Store not found — check your store URL");
  if (status !== 200) throw new Error(`Shopify API returned status ${status}`);

  return {
    shopName:   body?.shop?.name,
    shopDomain: body?.shop?.domain,
    shopEmail:  body?.shop?.email,
    currency:   body?.shop?.currency,
  };
}

// ── WooCommerce ───────────────────────────────────────────────
async function validateWooCommerce({ storeUrl, consumerKey, consumerSecret }) {
  if (!storeUrl || !consumerKey || !consumerSecret) {
    throw new Error("Missing WooCommerce credentials");
  }

  const base = storeUrl.replace(/\/$/, "");
  // Basic auth via query params (WooCommerce REST API v3)
  const params = new URLSearchParams({ consumer_key: consumerKey, consumer_secret: consumerSecret });
  const url    = `${base}/wp-json/wc/v3/system_status?${params}`;

  const { status, body } = await request(url);

  if (status === 401) throw new Error("Invalid WooCommerce credentials");
  if (status === 404) throw new Error("WooCommerce REST API not found — check URL and that REST API is enabled");
  if (status !== 200) throw new Error(`WooCommerce API returned status ${status}`);

  return {
    wooVersion:  body?.environment?.version,
    wpVersion:   body?.environment?.wp_version,
    storeName:   body?.settings?.store_name,
    timezone:    body?.settings?.timezone,
  };
}

module.exports = { validateShopify, validateWooCommerce };
