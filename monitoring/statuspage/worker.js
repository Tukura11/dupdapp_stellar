/**
 * Cloudflare Worker — status.cheesepay.xyz
 *
 * Routes:
 *   GET /          → serves the status page HTML (with API_BASE injected)
 *   GET /api/status → proxies GET https://api.cheesepay.xyz/health/admin
 *                     (avoids CORS issues; adds cache-control)
 *
 * Deploy:
 *   wrangler deploy
 *
 * Environment variables (set in wrangler.toml or Cloudflare dashboard):
 *   API_ORIGIN  = https://api.cheesepay.xyz   (no trailing slash)
 */

// ─── HTML is inlined at build time via wrangler's text_blobs or fetched ───────
// For simplicity we import it as a string. In wrangler.toml add:
//   [text_blobs]
//   STATUS_HTML = "index.html"
// Then reference it as STATUS_HTML below.
// If you prefer, replace with a fetch to your CDN.

// ─── Soroban-specific health check thresholds ────────────────────────────────
const SOROBAN_RPC_TIMEOUT_MS = 5000;   // RPC probe budget
const SOROBAN_RPC_DEGRADED_MS = 1500;  // response time above this → degraded
const EVENT_INDEXER_MAX_LAG_MS = 30_000; // last payment_escrow event must be < 30s old
const FEE_TEST_MERCHANT = 'test-merchant'; // merchant used for fee_calculator probe

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Proxy: /api/status → upstream /health/admin ──────────────────────────
    if (url.pathname === '/api/status') {
      return proxyHealthAdmin(env);
    }

    // ── Soroban-specific health checks ───────────────────────────────────────
    if (url.pathname === '/api/status/soroban') {
      return sorobanStatus(env);
    }

    // ── Status page HTML ──────────────────────────────────────────────────────
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveStatusPage(env);
    }

    // ── Favicon (prevent 404 noise) ───────────────────────────────────────────
    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    return new Response('Not found', { status: 404 });
  },
};

// ─── Proxy /health/admin ──────────────────────────────────────────────────────
async function proxyHealthAdmin(env) {
  const apiOrigin = env.API_ORIGIN ?? 'https://api.cheesepay.xyz';

  let upstreamRes;
  try {
    upstreamRes = await fetch(`${apiOrigin}/health/admin`, {
      headers: { Accept: 'application/json' },
      // Cloudflare fetch timeout is 30s by default
    });
  } catch (err) {
    // Network-level failure — API is unreachable
    return jsonResponse(
      {
        status: 'down',
        timestamp: new Date().toISOString(),
        components: {
          database:   { status: 'down', latency: 0 },
          stellar:    { status: 'down', latency: 0 },
          partnerApi: { status: 'down', latency: 0 },
          redis:      { status: 'down', latency: 0 },
          queue:      { status: 'down', latency: 0 },
        },
        error: 'API unreachable',
      },
      503,
    );
  }

  // Parse body regardless of status code (/health/admin returns 503 with body
  // when critical components are down)
  let body;
  try {
    body = await upstreamRes.json();
  } catch {
    body = { status: 'down', timestamp: new Date().toISOString(), error: 'Invalid response' };
  }

  return jsonResponse(body, upstreamRes.status, {
    // Cache for 30 seconds at the edge — status page polls every 60s so this
    // halves upstream load while keeping data fresh enough.
    'Cache-Control': 'public, max-age=30, s-maxage=30',
  });
}

// ─── Soroban-specific health checks ───────────────────────────────────────────
// Runs three probes in parallel and aggregates them into a single status body
// that mirrors the shape of /health/admin so the status page can render it.
async function sorobanStatus(env) {
  const apiOrigin = env.API_ORIGIN ?? 'https://api.cheesepay.xyz';
  const rpcUrl = env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';

  const [rpc, indexer, fee] = await Promise.all([
    checkSorobanRpc(rpcUrl),
    checkEventIndexer(apiOrigin),
    checkFeeCalculator(apiOrigin),
  ]);

  const components = {
    sorobanRpc: rpc,
    eventIndexer: indexer,
    feeCalculator: fee,
  };

  const anyDown = Object.values(components).some((c) => c.status === 'down');
  const anyDegraded = Object.values(components).some((c) => c.status === 'degraded');
  const status = anyDown ? 'down' : anyDegraded ? 'degraded' : 'up';

  return jsonResponse(
    { status, timestamp: new Date().toISOString(), components },
    anyDown ? 503 : 200,
    { 'Cache-Control': 'public, max-age=30, s-maxage=30' },
  );
}

// Check 1: Soroban RPC endpoint response time.
async function checkSorobanRpc(rpcUrl) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOROBAN_RPC_TIMEOUT_MS);

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: controller.signal,
    });
    const latency = Date.now() - started;

    if (!res.ok) {
      return { status: 'down', latency, error: `HTTP ${res.status}` };
    }

    let body;
    try {
      body = await res.json();
    } catch {
      return { status: 'down', latency, error: 'Invalid RPC response' };
    }

    if (body?.error) {
      return { status: 'down', latency, error: body.error.message ?? 'RPC error' };
    }

    const health = body?.result?.status;
    if (health && health !== 'healthy') {
      return { status: 'degraded', latency, error: `RPC status: ${health}` };
    }

    return {
      status: latency > SOROBAN_RPC_DEGRADED_MS ? 'degraded' : 'up',
      latency,
    };
  } catch (err) {
    return {
      status: 'down',
      latency: Date.now() - started,
      error: err?.name === 'AbortError' ? 'RPC timeout' : 'RPC unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

// Check 2: last payment_escrow event indexed within 30s.
async function checkEventIndexer(apiOrigin) {
  const started = Date.now();
  try {
    const res = await fetch(`${apiOrigin}/health/indexer`, {
      headers: { Accept: 'application/json' },
    });
    const latency = Date.now() - started;

    if (!res.ok) {
      return { status: 'down', latency, error: `HTTP ${res.status}` };
    }

    const body = await res.json();
    const lastEventAt = body?.lastEventAt ?? body?.lastPaymentEscrowEventAt;
    if (!lastEventAt) {
      return { status: 'down', latency, error: 'No payment_escrow event indexed' };
    }

    const lagMs = Date.now() - new Date(lastEventAt).getTime();
    if (!Number.isFinite(lagMs)) {
      return { status: 'down', latency, error: 'Invalid lastEventAt' };
    }

    return {
      status: lagMs > EVENT_INDEXER_MAX_LAG_MS ? 'down' : 'up',
      latency,
      lagMs,
      lastEventAt,
      ...(lagMs > EVENT_INDEXER_MAX_LAG_MS
        ? { error: `Indexer lag ${Math.round(lagMs / 1000)}s exceeds 30s` }
        : {}),
    };
  } catch {
    return { status: 'down', latency: Date.now() - started, error: 'Indexer unreachable' };
  }
}

// Check 3: fee_calculator returns a valid fee for a test merchant.
async function checkFeeCalculator(apiOrigin) {
  const started = Date.now();
  try {
    const res = await fetch(
      `${apiOrigin}/fees/calculate?merchant=${encodeURIComponent(FEE_TEST_MERCHANT)}`,
      { headers: { Accept: 'application/json' } },
    );
    const latency = Date.now() - started;

    if (!res.ok) {
      return { status: 'down', latency, error: `HTTP ${res.status}` };
    }

    const body = await res.json();
    const fee = body?.fee ?? body?.feeAmount ?? body?.amount;
    const feeNum = typeof fee === 'string' ? Number(fee) : fee;

    if (typeof feeNum !== 'number' || !Number.isFinite(feeNum) || feeNum < 0) {
      return { status: 'down', latency, error: 'Invalid fee returned' };
    }

    return { status: 'up', latency, fee: feeNum };
  } catch {
    return { status: 'down', latency: Date.now() - started, error: 'Fee calculator unreachable' };
  }
}

// ─── Serve status page HTML ───────────────────────────────────────────────────
async function serveStatusPage(env) {
  // STATUS_HTML is bound as a text blob in wrangler.toml.
  // Fallback: fetch from the same worker's origin (useful in local dev).
  const html = typeof STATUS_HTML !== 'undefined'
    ? STATUS_HTML
    : await fetchFallbackHtml();

  // Inject the API base so the page calls /api/status (this worker's proxy)
  // instead of the real API directly — avoids CORS entirely.
  const injected = html.replace(
    "window.__API_BASE__ || 'https://api.cheesepay.xyz'",
    "window.__API_BASE__ || ''",  // empty string → relative URL /api/status
  ).replace(
    "`${API_BASE}/health/admin`",
    "`${API_BASE}/api/status`",
  );

  return new Response(injected, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

async function fetchFallbackHtml() {
  // Only used in local wrangler dev when text_blobs aren't available
  return '<html><body>Status page loading...</body></html>';
}
