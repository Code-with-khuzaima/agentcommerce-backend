/**
 * AgentCommerce AI Widget — Integration Snippet
 * =============================================
 * This snippet is embedded into customer stores after successful onboarding.
 * Replace STORE_ID_PLACEHOLDER with the actual store ID from your database.
 *
 * For Shopify: Add to Online Store → Themes → Edit code → theme.liquid before </body>
 * For WooCommerce: Add to Appearance → Theme Editor → footer.php before </body>
 *   OR use a plugin like "Insert Headers and Footers"
 */

(function (window, document, scriptTag, configKey) {
  "use strict";

  // ── Configuration ────────────────────────────────────────
  var CONFIG = {
    storeId:    "{{STORE_ID}}",          // Injected by AgentCommerce
    platform:   "{{PLATFORM}}",          // 'shopify' | 'woocommerce'
    apiBase:    "https://api.agentcommerce.ai",
    cdnBase:    "https://cdn.agentcommerce.ai",
    theme:      "auto",                  // 'auto' | 'light' | 'dark'
    position:   "bottom-right",          // 'bottom-right' | 'bottom-left'
    primaryColor: "#7c3aed",
  };

  // Merge any user-provided overrides
  if (window.AgentCommerceConfig) {
    for (var k in window.AgentCommerceConfig) {
      if (window.AgentCommerceConfig.hasOwnProperty(k)) {
        CONFIG[k] = window.AgentCommerceConfig[k];
      }
    }
  }

  // ── Guard: don't load twice ───────────────────────────────
  if (window.__agentCommerceLoaded) return;
  window.__agentCommerceLoaded = true;

  // ── State ─────────────────────────────────────────────────
  var state = {
    open: false,
    messages: [],
    sessionId: generateSessionId(),
    context: gatherPageContext(),
  };

  // ── Utility: session ID ───────────────────────────────────
  function generateSessionId() {
    return "acs_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // ── Utility: gather page context ──────────────────────────
  function gatherPageContext() {
    var ctx = {
      url:      window.location.href,
      referrer: document.referrer,
      title:    document.title,
    };

    // Shopify: grab product data if on product page
    if (window.ShopifyAnalytics && window.ShopifyAnalytics.meta) {
      ctx.product  = window.ShopifyAnalytics.meta.product;
      ctx.currency = window.Shopify && window.Shopify.currency && window.Shopify.currency.active;
    }

    // WooCommerce: grab product/cart info from body classes
    var bodyClasses = document.body.className;
    if (bodyClasses.indexOf("single-product") > -1) ctx.pageType = "product";
    if (bodyClasses.indexOf("woocommerce-cart") > -1) ctx.pageType = "cart";
    if (bodyClasses.indexOf("woocommerce-checkout") > -1) ctx.pageType = "checkout";

    return ctx;
  }

  // ── CSS injection ─────────────────────────────────────────
  function injectStyles() {
    var css = [
      "#ac-widget-btn{position:fixed;z-index:2147483640;width:56px;height:56px;border-radius:50%;",
      "background:" + CONFIG.primaryColor + ";box-shadow:0 4px 24px rgba(124,58,237,0.4);",
      "border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;",
      "transition:transform 0.2s,box-shadow 0.2s;}",
      "#ac-widget-btn:hover{transform:scale(1.08);box-shadow:0 6px 32px rgba(124,58,237,0.55);}",
      CONFIG.position === "bottom-right"
        ? "#ac-widget-btn{bottom:24px;right:24px;}"
        : "#ac-widget-btn{bottom:24px;left:24px;}",

      "#ac-widget-panel{position:fixed;z-index:2147483639;width:360px;height:520px;",
      "border-radius:16px;overflow:hidden;box-shadow:0 16px 64px rgba(0,0,0,0.3);",
      "display:none;flex-direction:column;",
      "transition:opacity 0.25s,transform 0.25s;}",
      CONFIG.position === "bottom-right"
        ? "#ac-widget-panel{bottom:92px;right:24px;}"
        : "#ac-widget-panel{bottom:92px;left:24px;}",
      "#ac-widget-panel.ac-open{display:flex;}",

      "@media(max-width:480px){",
        "#ac-widget-panel{width:calc(100vw - 16px);height:70vh;",
        CONFIG.position === "bottom-right" ? "right:8px;" : "left:8px;",
        "bottom:88px;}",
      "}",
    ].join("");

    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── DOM: build widget ─────────────────────────────────────
  function buildWidget() {
    // Toggle button
    var btn = document.createElement("button");
    btn.id = "ac-widget-btn";
    btn.setAttribute("aria-label", "Open AI assistant");
    btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2">'
      + '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>'
      + "</svg>";

    // Panel: iframe
    var panel = document.createElement("div");
    panel.id = "ac-widget-panel";

    var iframe = document.createElement("iframe");
    iframe.src = CONFIG.cdnBase + "/chat?"
      + "storeId=" + encodeURIComponent(CONFIG.storeId)
      + "&platform=" + encodeURIComponent(CONFIG.platform)
      + "&theme=" + encodeURIComponent(CONFIG.theme)
      + "&sessionId=" + encodeURIComponent(state.sessionId)
      + "&ctx=" + encodeURIComponent(JSON.stringify(state.context));
    iframe.style.cssText = "width:100%;height:100%;border:none;";
    iframe.setAttribute("title", "AI Shopping Assistant");
    iframe.setAttribute("allow", "microphone");

    panel.appendChild(iframe);

    btn.addEventListener("click", function () {
      state.open = !state.open;
      panel.classList.toggle("ac-open", state.open);
      btn.setAttribute("aria-expanded", state.open ? "true" : "false");
      btn.innerHTML = state.open
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>'
        : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';
    });

    // Close on Escape
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && state.open) btn.click();
    });

    // Cross-frame messaging
    window.addEventListener("message", function (e) {
      if (e.origin !== CONFIG.cdnBase) return;
      if (e.data && e.data.type === "ac:close") btn.click();
    });

    document.body.appendChild(btn);
    document.body.appendChild(panel);
  }

  // ── Track analytics event ─────────────────────────────────
  function trackEvent(name, data) {
    if (!navigator.sendBeacon) return;
    navigator.sendBeacon(
      CONFIG.apiBase + "/analytics/event",
      JSON.stringify({
        storeId:   CONFIG.storeId,
        sessionId: state.sessionId,
        event:     name,
        data:      data || {},
        url:       window.location.href,
        ts:        Date.now(),
      })
    );
  }

  // ── Bootstrap ─────────────────────────────────────────────
  function init() {
    injectStyles();
    buildWidget();
    trackEvent("widget_loaded", { platform: CONFIG.platform });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})(window, document, "script", "AgentCommerceConfig");

/* 
 * ═══════════════════════════════════════════════════════════
 * SHOPIFY INSTALLATION — Add to theme.liquid before </body>:
 * ═══════════════════════════════════════════════════════════
 * <script>
 *   window.AgentCommerceConfig = {
 *     storeId: "YOUR_STORE_ID",
 *     platform: "shopify",
 *     theme: "auto"
 *   };
 * </script>
 * <script async src="https://cdn.agentcommerce.ai/widget.js"></script>
 *
 * ═══════════════════════════════════════════════════════════
 * WOOCOMMERCE INSTALLATION — Add via plugin or footer.php:
 * ═══════════════════════════════════════════════════════════
 * <script>
 *   window.AgentCommerceConfig = {
 *     storeId: "YOUR_STORE_ID",
 *     platform: "woocommerce",
 *     theme: "auto"
 *   };
 * </script>
 * <script async src="https://cdn.agentcommerce.ai/widget.js"></script>
 */
