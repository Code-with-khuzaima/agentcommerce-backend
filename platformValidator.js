// ============================================================
// platformValidator.js
// Real API validation for Shopify and WooCommerce
// ============================================================

/**
 * Validate Shopify credentials by calling the Shop API
 * Returns shop info if valid, throws error if invalid
 */
async function validateShopify({ storeUrl, apiKey, accessToken }) {
  if (!apiKey || !accessToken) {
    throw new Error("Client ID and Client Secret are required");
  }

  // Clean up store URL — extract just the domain
  let domain = storeUrl
    .replace(/^https?:\/\//, "")  // remove https://
    .replace(/\/$/, "")            // remove trailing slash
    .split("/")[0];                // take only domain part

  let adminAccessToken = accessToken;

  // New Dev Dashboard apps expose client ID + client secret, which must be
  // exchanged for a short-lived Admin API token before validating API access.
  if (/^shpss_/i.test(accessToken.trim())) {
    const tokenResponse = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: apiKey.trim(),
        client_secret: accessToken.trim(),
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (tokenResponse.status === 401 || tokenResponse.status === 403) {
      throw new Error("Invalid Shopify client credentials. Please check your Client ID and Client Secret.");
    }

    if (tokenResponse.status === 404) {
      throw new Error("Store not found. Please check your store URL.");
    }

    if (!tokenResponse.ok) {
      throw new Error(`Shopify token exchange failed with error ${tokenResponse.status}. Make sure the app is installed and scopes are released.`);
    }

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
      throw new Error("Shopify did not return an Admin API access token. Make sure your app is installed on the store.");
    }

    adminAccessToken = tokenData.access_token;
  }

  // Build Shopify API URL
  const url = `https://${domain}/admin/api/2024-01/shop.json`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": adminAccessToken,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (response.status === 401) {
      throw new Error("Invalid Shopify credentials. Please check your Client ID and Client Secret.");
    }

    if (response.status === 403) {
      throw new Error("Access denied. Make sure your app has the correct permissions.");
    }

    if (response.status === 404) {
      throw new Error("Store not found. Please check your store URL.");
    }

    if (!response.ok) {
      throw new Error(`Shopify returned error ${response.status}. Please verify the store URL, app installation, and credentials.`);
    }

    const data = await response.json();

    if (!data.shop) {
      throw new Error("Could not retrieve store information.");
    }

    // Return useful shop info
    return {
      name: data.shop.name,
      email: data.shop.email,
      domain: data.shop.domain,
      currency: data.shop.currency,
      country: data.shop.country_name,
      plan: data.shop.plan_display_name,
    };

  } catch (err) {
    // Re-throw our custom errors
    if (err.message && !err.message.includes("fetch")) {
      throw err;
    }
    // Network/timeout errors
    throw new Error("Could not connect to your store. Please check your store URL and try again.");
  }
}

/**
 * Validate WooCommerce credentials by calling the System Status API
 * Returns store info if valid, throws error if invalid
 */
async function validateWooCommerce({ storeUrl, consumerKey, consumerSecret }) {
  if (!consumerKey || !consumerSecret) {
    throw new Error("Consumer Key and Consumer Secret are required");
  }

  // Clean up store URL
  let baseUrl = storeUrl.replace(/\/$/, ""); // remove trailing slash

  // Build WooCommerce API URL
  const url = `${baseUrl}/wp-json/wc/v3/system_status`;

  // WooCommerce uses Basic Auth with consumer key and secret
  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (response.status === 401) {
      throw new Error("Invalid credentials. Please check your Consumer Key and Secret.");
    }

    if (response.status === 403) {
      throw new Error("Access denied. Make sure your API key has Read/Write permissions.");
    }

    if (response.status === 404) {
      // Try the products endpoint as fallback
      const fallbackUrl = `${baseUrl}/wp-json/wc/v3/products?per_page=1`;
      const fallbackRes = await fetch(fallbackUrl, {
        method: "GET",
        headers: {
          "Authorization": `Basic ${credentials}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (fallbackRes.status === 401) {
        throw new Error("Invalid credentials. Please check your Consumer Key and Secret.");
      }

      if (!fallbackRes.ok) {
        throw new Error("Store not found or WooCommerce REST API is not enabled. Check your permalink settings.");
      }

      return {
        name: baseUrl,
        status: "connected",
        note: "WooCommerce store connected successfully",
      };
    }

    if (!response.ok) {
      throw new Error(`WooCommerce returned error ${response.status}. Please check your credentials.`);
    }

    const data = await response.json();

    // Return useful store info
    return {
      name: data.environment?.site_url || baseUrl,
      version: data.environment?.wc_version || "Unknown",
      currency: data.settings?.currency || "Unknown",
      status: "connected",
    };

  } catch (err) {
    // Re-throw our custom errors
    if (err.message && !err.message.includes("fetch") && !err.message.includes("abort")) {
      throw err;
    }
    // Network/timeout errors
    throw new Error("Could not connect to your store. Please check your store URL and try again.");
  }
}

module.exports = { validateShopify, validateWooCommerce };
