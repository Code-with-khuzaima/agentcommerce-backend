function buildInstallGuideTemplate(store = {}) {
  const isWoo = store.platform === "woocommerce";
  const storeName = store.storeName || "your store";
  const storeId = store.storeId || "store_001";

  return [
    `AgentComerce install guide for ${storeName}`,
    "",
    isWoo ? "1. Open your WordPress admin panel." : "1. Open Shopify Admin.",
    isWoo ? "2. Open the footer script or code snippet area used for custom code." : "2. Go to Online Store > Themes > Edit code.",
    isWoo ? "3. Paste the AgentComerce widget snippet in the footer area." : "3. Open theme.liquid.",
    isWoo ? "4. Save changes and refresh your storefront." : "4. Paste the AgentComerce widget snippet before the closing </body> tag.",
    isWoo ? "" : "5. Save the file and refresh your storefront.",
    "",
    `Store ID: ${storeId}`,
    "",
    "After install:",
    "1. Open the storefront.",
    "2. Open the chat widget.",
    "3. Send one test message.",
    "4. Reply to this email if anything fails.",
  ].filter(Boolean).join("\n");
}

module.exports = {
  buildInstallGuideTemplate,
};
