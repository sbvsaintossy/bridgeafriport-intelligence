/**
 * BridgeAfriport Intelligence Engine
 * Cloudflare Pages Function: /scrape
 *
 * One endpoint, three ways to use it:
 *   POST /scrape  {"urls": [...]}            -> dashboard / REST (JSON)
 *   POST /scrape  {"jsonrpc":"2.0", ...}     -> MCP server (Streamable HTTP) for Claude custom connectors
 *   GET  /scrape                             -> OpenAPI 3.1 schema (for any OpenAPI-style tool runner)
 *
 * SECRETS: Never paste real keys into this file. The repo is version-controlled.
 * Set them in Cloudflare: Pages project -> Settings -> Variables and Secrets (type: Secret).
 */

// ─────────────────────────────────────────────────────────────
// 1. API TOKEN PLACEHOLDERS (read from Cloudflare secrets at runtime)
// ─────────────────────────────────────────────────────────────
const SCRAPERAPI_KEY_VAR = "SCRAPERAPI_KEY";      // ScraperAPI
const SCRAPINGBEE_KEY_VAR = "SCRAPINGBEE_KEY";    // ScrapingBee
const BRIGHTDATA_TOKEN_VAR = "BRIGHTDATA_TOKEN";  // Bright Data (Web Unlocker API token)
const BRIGHTDATA_ZONE_VAR = "BRIGHTDATA_ZONE";    // Bright Data zone name (default: web_unlocker1)
const ZENROWS_KEY_VAR = "ZENROWS_KEY";            // ZenRows
const SCRAPFLY_KEY_VAR = "SCRAPFLY_KEY";          // Scrapfly
const ACCESS_KEY_VAR = "BRIDGE_ACCESS_KEY";       // Optional: protects your credits from strangers
// KV namespace binding name (Settings -> Bindings -> KV namespace): BRIDGE_KV

// ─────────────────────────────────────────────────────────────
// 2. BUDGET + LIMITS
// ─────────────────────────────────────────────────────────────
const DAILY_CAP = 433;               // 13,000 credits / 30 days
const MAX_URLS_PER_REQUEST = 10;     // keeps each call well under Cloudflare subrequest limits
const PROVIDER_TIMEOUT_MS = 45000;
const BRAND = "BridgeAfriport";
const SERVER_VERSION = "1.0.0";

const MSG_EXHAUSTED = "BridgeAfriport Data Engines Exhausted";
const MSG_CAP = `BridgeAfriport daily free credit budget of ${DAILY_CAP} leads reached. Resets tomorrow.`;

// ─────────────────────────────────────────────────────────────
// 3. INTENT SIGNALS
// ─────────────────────────────────────────────────────────────
const POSITIVE_SIGNALS = [
  "Export Manager",
  "International Sales Director",
  "hiring export",
  "secured loan",
  "expansion funding",
];
const NEGATIVE_SIGNALS = ["Africa", "Nigeria", "Kenya", "South Africa", "Ghana", "Lagos", "Nairobi"];

// ─────────────────────────────────────────────────────────────
// 4. THE 5-API FAILOVER CHAIN (strict order)
// Each provider routes through its own global proxy pool. Geo-targeting
// flags are left off on purpose: on most free tiers they cost extra credits.
// ─────────────────────────────────────────────────────────────
const PROVIDERS = [
  {
    name: "ScraperAPI",
    keyVar: SCRAPERAPI_KEY_VAR,
    build: (url, key) => ({
      endpoint: `https://api.scraperapi.com/?api_key=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}`,
      init: { method: "GET" },
    }),
  },
  {
    name: "ScrapingBee",
    keyVar: SCRAPINGBEE_KEY_VAR,
    build: (url, key) => ({
      endpoint: `https://app.scrapingbee.com/api/v1/?api_key=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}&render_js=false`,
      init: { method: "GET" },
    }),
  },
  {
    name: "Bright Data",
    keyVar: BRIGHTDATA_TOKEN_VAR,
    build: (url, key, env) => ({
      endpoint: "https://api.brightdata.com/request",
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ zone: env[BRIGHTDATA_ZONE_VAR] || "web_unlocker1", url, format: "raw" }),
      },
    }),
  },
  {
    name: "ZenRows",
    keyVar: ZENROWS_KEY_VAR,
    build: (url, key) => ({
      endpoint: `https://api.zenrows.com/v1/?apikey=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}`,
      init: { method: "GET" },
    }),
  },
  {
    name: "Scrapfly",
    keyVar: SCRAPFLY_KEY_VAR,
    build: (url, key) => ({
      endpoint: `https://api.scrapfly.io/scrape?key=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}`,
      init: { method: "GET" },
    }),
    // Scrapfly wraps the page in JSON
    extract: async (res) => {
      const data = await res.json();
      return data?.result?.content || "";
    },
  },
];

// ─────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Bridge-Key, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

function isAuthorized(request, env) {
  const required = env[ACCESS_KEY_VAR];
  if (!required) return true; // open mode (not recommended once live)
  const u = new URL(request.url);
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const supplied = u.searchParams.get("key") || request.headers.get("X-Bridge-Key") || bearer;
  return supplied === required;
}

// ─────────────────────────────────────────────────────────────
// Daily budget counter (Cloudflare KV, keyed by UTC date)
// ─────────────────────────────────────────────────────────────
const memoryCounter = { day: "", count: 0 }; // fallback only; NOT reliable across isolates

function todayKey() {
  return `bridgeafriport:usage:${new Date().toISOString().slice(0, 10)}`;
}

async function getUsage(env) {
  const key = todayKey();
  if (env.BRIDGE_KV) return parseInt((await env.BRIDGE_KV.get(key)) || "0", 10);
  if (memoryCounter.day !== key) Object.assign(memoryCounter, { day: key, count: 0 });
  return memoryCounter.count;
}

async function addUsage(env, n) {
  if (n <= 0) return getUsage(env);
  const key = todayKey();
  if (env.BRIDGE_KV) {
    const next = (await getUsage(env)) + n;
    await env.BRIDGE_KV.put(key, String(next), { expirationTtl: 60 * 60 * 48 });
    return next;
  }
  if (memoryCounter.day !== key) Object.assign(memoryCounter, { day: key, count: 0 });
  memoryCounter.count += n;
  return memoryCounter.count;
}

// ─────────────────────────────────────────────────────────────
// Scraping with sequential failover
// ─────────────────────────────────────────────────────────────
async function fetchWithTimeout(endpoint, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(endpoint, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function scrapeWithFailover(url, env) {
  const attempts = [];
  for (const p of PROVIDERS) {
    const key = env[p.keyVar];
    if (!key) {
      attempts.push({ provider: p.name, status: "skipped", reason: `${p.keyVar} not set` });
      continue;
    }
    try {
      const { endpoint, init } = p.build(url, key, env);
      const res = await fetchWithTimeout(endpoint, init);
      if (!res.ok) {
        // 401/402/403 (credits/firewall), 429 (rate limit), 5xx (upstream) -> next engine
        attempts.push({ provider: p.name, status: "failed", http: res.status });
        continue;
      }
      const html = p.extract ? await p.extract(res) : await res.text();
      if (!html || html.length < 200) {
        attempts.push({ provider: p.name, status: "failed", reason: "empty or blocked page" });
        continue;
      }
      attempts.push({ provider: p.name, status: "ok" });
      return { ok: true, provider: p.name, html, attempts };
    } catch (err) {
      attempts.push({ provider: p.name, status: "failed", reason: err.name === "AbortError" ? "timeout" : String(err.message || err) });
    }
  }
  return { ok: false, attempts };
}

// ─────────────────────────────────────────────────────────────
// Intent extraction
// ─────────────────────────────────────────────────────────────
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findSignals(text, list) {
  // Word-boundary at the start; "Africa" also catches "African"
  return list.filter((s) => new RegExp(`\\b${escapeRe(s)}`, "i").test(text));
}

function analyze(html) {
  const text = htmlToText(html);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  const positive = findSignals(text, POSITIVE_SIGNALS);
  const negative = findSignals(text, NEGATIVE_SIGNALS);

  let tag, intent;
  if (negative.length) {
    tag = "HAS FOOTPRINT";
    intent = "EXCLUDE";
  } else if (positive.length) {
    tag = "NO FOOTPRINT";
    intent = positive.length >= 2 ? "HIGH INTENT" : "MEDIUM INTENT";
  } else {
    tag = "NO FOOTPRINT";
    intent = "NO SIGNAL";
  }
  return { title: title.slice(0, 160), tag, intent, positive_signals: positive, negative_signals: negative, text_length: text.length };
}

function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Core job (shared by REST + MCP)
// ─────────────────────────────────────────────────────────────
async function runJob(rawUrls, env) {
  const list = (Array.isArray(rawUrls) ? rawUrls : [rawUrls]).filter(Boolean);
  if (!list.length) return { status: 400, body: { ok: false, brand: BRAND, error: "Provide at least one URL in 'urls'." } };
  if (list.length > MAX_URLS_PER_REQUEST)
    return { status: 400, body: { ok: false, brand: BRAND, error: `Max ${MAX_URLS_PER_REQUEST} URLs per request.` } };

  let used = await getUsage(env);
  if (used >= DAILY_CAP) return { status: 429, body: { ok: false, brand: BRAND, error: MSG_CAP, budget: budget(used) } };

  const results = [];
  let successes = 0;
  let enginesExhausted = false;

  for (const raw of list) {
    const url = normalizeUrl(raw);
    if (!url) {
      results.push({ url: String(raw), ok: false, error: "Invalid URL" });
      continue;
    }
    if (used + successes >= DAILY_CAP) {
      results.push({ url, ok: false, error: MSG_CAP });
      continue;
    }
    const r = await scrapeWithFailover(url, env);
    if (!r.ok) {
      enginesExhausted = true;
      results.push({ url, ok: false, error: MSG_EXHAUSTED, attempts: r.attempts });
      continue;
    }
    successes++;
    results.push({ url, ok: true, engine: r.provider, ...analyze(r.html), attempts: r.attempts });
  }

  used = await addUsage(env, successes);
  const allFailed = successes === 0 && enginesExhausted;
  return {
    status: allFailed ? 502 : 200,
    body: {
      ok: !allFailed,
      brand: BRAND,
      ...(allFailed ? { error: MSG_EXHAUSTED } : {}),
      processed: list.length,
      successful: successes,
      budget: budget(used),
      results,
    },
  };
}

function budget(used) {
  return { daily_cap: DAILY_CAP, used_today: used, remaining_today: Math.max(0, DAILY_CAP - used), resets: "00:00 UTC" };
}

// ─────────────────────────────────────────────────────────────
// MCP (Model Context Protocol) — stateless Streamable HTTP, JSON responses
// ─────────────────────────────────────────────────────────────
const MCP_TOOLS = [
  {
    name: "bridgeafriport_scrape_leads",
    title: "BridgeAfriport Lead Intent Scan",
    description:
      "Scrapes up to 10 company websites through BridgeAfriport's 5-engine failover and scores B2B export intent. " +
      "Returns per-URL intent (HIGH/MEDIUM/NO SIGNAL), matched positive signals (export hiring, funding), and " +
      "tags any site that already mentions an African footprint as 'HAS FOOTPRINT'. Each successful URL uses 1 of 433 daily credits.",
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_URLS_PER_REQUEST, description: "Company website URLs" },
      },
      required: ["urls"],
    },
  },
  {
    name: "bridgeafriport_budget_status",
    title: "BridgeAfriport Budget Status",
    description: "Shows how many of today's 433 BridgeAfriport scraping credits have been used. Costs nothing.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function handleMcp(msg, env) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "bridgeafriport", title: "BridgeAfriport Intelligence", version: SERVER_VERSION },
        instructions: "Use bridgeafriport_scrape_leads to qualify company websites for African market-entry outreach.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: MCP_TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name === "bridgeafriport_budget_status") {
        const b = budget(await getUsage(env));
        return reply({ content: [{ type: "text", text: JSON.stringify(b, null, 2) }], structuredContent: b });
      }
      if (name === "bridgeafriport_scrape_leads") {
        const { body } = await runJob(args.urls, env);
        // Trim the noisy attempt log for Claude; keep it in REST mode
        const slim = { ...body, results: (body.results || []).map(({ attempts, ...r }) => r) };
        return reply({
          content: [{ type: "text", text: JSON.stringify(slim, null, 2) }],
          structuredContent: slim,
          isError: !body.ok,
        });
      }
      return fail(-32602, `Unknown tool: ${name}`);
    }
    default:
      if (method?.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${method}`);
  }
}

// ─────────────────────────────────────────────────────────────
// OpenAPI 3.1 schema (GET /scrape)
// ─────────────────────────────────────────────────────────────
function openApi(origin) {
  return {
    openapi: "3.1.0",
    info: { title: "BridgeAfriport Intelligence API", version: SERVER_VERSION, description: "B2B lead intent filtering with 5-engine scraping failover." },
    servers: [{ url: origin }],
    paths: {
      "/scrape": {
        post: {
          operationId: "bridgeafriportScrapeLeads",
          summary: "Scrape and score company websites for export intent",
          parameters: [{ name: "key", in: "query", required: false, schema: { type: "string" }, description: "BRIDGE_ACCESS_KEY if set" }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["urls"],
                  properties: { urls: { type: "array", items: { type: "string" }, maxItems: MAX_URLS_PER_REQUEST } },
                },
              },
            },
          },
          responses: {
            200: { description: "Scored results" },
            429: { description: MSG_CAP },
            502: { description: MSG_EXHAUSTED },
          },
        },
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Cloudflare Pages entry points
// ─────────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  if (u.searchParams.has("budget")) {
    if (!isAuthorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
    return json({ ok: true, brand: BRAND, budget: budget(await getUsage(env)) });
  }
  // MCP clients may try to open an SSE stream with GET; we are stateless, so decline politely
  if ((request.headers.get("Accept") || "").includes("text/event-stream")) {
    return new Response("SSE stream not supported; use POST.", { status: 405, headers: { Allow: "POST", ...CORS } });
  }
  return json(openApi(u.origin));
}

export async function onRequestPost({ request, env }) {
  if (!isAuthorized(request, env)) return json({ ok: false, brand: BRAND, error: "Unauthorized: missing or wrong access key." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }, 400);
  }

  // MCP JSON-RPC (single or batch)
  const isRpc = (m) => m && typeof m === "object" && m.jsonrpc === "2.0";
  if (isRpc(body) || (Array.isArray(body) && body.some(isRpc))) {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleMcp(m, env)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
    }
    const out = await handleMcp(body, env);
    return out ? json(out) : new Response(null, { status: 202, headers: CORS });
  }

  // Dashboard / REST
  const { status, body: result } = await runJob(body.urls ?? body.url, env);
  return json(result, status);
}
