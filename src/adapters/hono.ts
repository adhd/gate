import type { MiddlewareHandler, Context, Next } from "hono";
import { Hono } from "hono";
import type {
  GateConfig,
  GateMiddlewareOptions,
  ResolvedConfig,
  KeyRecord,
} from "../types.js";
import { resolveConfig } from "../config.js";
import { handleGatedRequest } from "../core.js";
import { extractKeyFromRequest, generateKey } from "../keys.js";
import {
  formatPrice,
  formatCredits,
  successPageHtml,
  webhookErrorStatus,
} from "../errors.js";
import {
  createCheckoutSession,
  handleCheckoutSuccess,
  handleWebhook,
} from "../stripe.js";
import {
  buildX402PaymentRequired,
  encodePaymentRequired,
  extractX402Payment,
  verifyX402Payment,
  settleX402Payment,
} from "../crypto/x402.js";
import { buildMppChallenge } from "../crypto/mpp.js";

// --- Types ---

export interface GateMiddleware extends MiddlewareHandler {
  /** Middleware that handles management routes (/buy, /success, /status, /pricing, /webhook). Mount at your routePrefix. */
  routes: MiddlewareHandler;
  /** Returns a new billing middleware with a different credit cost. */
  cost(n: number): MiddlewareHandler;
  /** The resolved configuration. */
  resolved: ResolvedConfig;
}

// --- Helpers ---

function honoHeaders(c: Context): Record<string, string> {
  const h: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    h[k.toLowerCase()] = v;
  });
  return h;
}

function createBillingMiddleware(
  resolved: ResolvedConfig,
  cost: number,
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const headers = honoHeaders(c);
    const ctx = {
      apiKey: extractKeyFromRequest(headers, c.req.url),
      clientType: null,
      url: c.req.url,
      method: c.req.method,
      headers,
    };

    const result = await handleGatedRequest(ctx, resolved, { cost });

    switch (result.action) {
      case "pass":
        c.header("X-Gate-Credits-Remaining", String(result.remaining));
        await next();
        break;
      case "pass_crypto":
        c.header("X-Payment-Payer", result.payer);
        c.header("X-Payment-Protocol", result.protocol);
        await next();
        break;
      case "fail_open":
        await next();
        break;
      case "redirect":
        return c.redirect(result.url, 302);
      case "payment_required":
        c.header("X-Payment-Protocol", "gate/v1");
        if (resolved.crypto) {
          const x402 = buildX402PaymentRequired(resolved, c.req.url, cost);
          c.header("PAYMENT-REQUIRED", encodePaymentRequired(x402));
          const mppChallenge = buildMppChallenge(
            {
              realm: new URL(c.req.url).hostname,
              method: "tempo",
              intent: "charge",
              amount: resolved.crypto.amountSmallestUnit,
              currency: resolved.crypto.asset,
              recipient: resolved.crypto.address,
            },
            resolved.crypto.mppSecret,
          );
          c.header("WWW-Authenticate", mppChallenge);
        }
        return c.json(result.body, 402);
      case "error":
        return c.json({ error: result.message }, result.status);
    }
  };
}

/**
 * Build a Hono sub-app with all gate management routes.
 * This is the single source of truth for route handlers.
 */
function buildRoutesApp(resolved: ResolvedConfig): Hono {
  const app = new Hono();

  app.get("/buy", async (c) => {
    try {
      const url = await createCheckoutSession(resolved);
      const accept = c.req.header("accept") || "";
      if (accept.includes("application/json")) {
        return c.json({ checkout_url: url });
      }
      return c.redirect(url, 302);
    } catch {
      return c.json({ error: "Failed to create checkout session" }, 500);
    }
  });

  app.get("/success", async (c) => {
    const sessionId = c.req.query("session_id");
    if (!sessionId) {
      return c.json({ error: "Missing session_id" }, 400);
    }
    try {
      const result = await handleCheckoutSuccess(
        sessionId,
        resolved,
        resolved.store,
      );
      if (!result) {
        return c.json({ error: "Payment not verified" }, 400);
      }
      const accept = c.req.header("accept") || "";
      if (accept.includes("application/json")) {
        return c.json({
          api_key: result.key,
          credits: result.record.credits,
          message: `Your API key has ${result.record.credits} credits.`,
        });
      }
      return c.html(successPageHtml(result.key, result.record.credits));
    } catch {
      return c.json({ error: "Payment verification failed" }, 400);
    }
  });

  app.get("/status", async (c) => {
    const headers = honoHeaders(c);
    const apiKey = extractKeyFromRequest(headers, c.req.url);
    if (!apiKey) return c.json({ error: "API key required" }, 401);
    const record = await resolved.store.get(apiKey);
    if (!record) return c.json({ error: "Invalid API key" }, 401);
    return c.json({
      credits_remaining: record.credits,
      created_at: record.createdAt,
      last_used_at: record.lastUsedAt,
    });
  });

  app.get("/pricing", (c) => {
    const { price, currency, amount } = resolved.credits;
    return c.json({
      credits: amount,
      price,
      currency,
      formatted: `${formatPrice(price, currency)} for ${formatCredits(amount)} API calls`,
    });
  });

  app.post("/webhook", async (c) => {
    const body = await c.req.text();
    const signature = c.req.header("stripe-signature");
    if (!signature) {
      return c.json({ error: "Missing stripe-signature header" }, 400);
    }
    try {
      await handleWebhook(body, signature, resolved, resolved.store);
      return c.json({ received: true });
    } catch (err) {
      const status = webhookErrorStatus(err);
      return c.json({ error: "Webhook processing failed" }, status);
    }
  });

  app.get("/test-key", async (c) => {
    if (resolved.mode !== "test") {
      return c.json(
        {
          error:
            "test-key endpoint is only available in test mode (GATE_MODE=test)",
        },
        403,
      );
    }

    const key = generateKey("test");
    const record: KeyRecord = {
      key,
      credits: resolved.credits.amount,
      stripeCustomerId: null,
      stripeSessionId: `test_key_${Date.now()}`,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    await resolved.store.set(key, record);

    return c.json({
      api_key: key,
      credits: resolved.credits.amount,
      mode: "test",
      message: `Test key created with ${resolved.credits.amount} credits. Use: Authorization: Bearer ${key}`,
    });
  });

  app.post("/buy-crypto", async (c) => {
    if (!resolved.crypto) {
      return c.json({ error: "Crypto payments not configured" }, 404);
    }

    const headers = honoHeaders(c);
    if (!headers["payment-signature"] && !headers["x-payment"]) {
      return c.json(
        {
          error:
            "Missing payment. Include a payment-signature or x-payment header.",
        },
        400,
      );
    }

    const payment = extractX402Payment(headers);
    if (!payment) {
      return c.json({ error: "Malformed payment payload" }, 400);
    }

    // Total price for the credit pack in smallest unit
    const totalUsd = resolved.crypto.pricePerCallUsd * resolved.credits.amount;
    const totalSmallestUnit = Math.round(
      totalUsd * Math.pow(10, resolved.crypto.assetDecimals),
    ).toString();

    const acceptsList = resolved.crypto.networks.map((network) => ({
      scheme: "exact" as const,
      network,
      asset: resolved.crypto!.asset,
      amount: totalSmallestUnit,
      payTo: resolved.crypto!.address,
      maxTimeoutSeconds: 120,
      extra: { name: "USD Coin", version: "2" },
    }));

    const matchedReq =
      acceptsList.find((a) => a.network === payment.accepted?.network) ||
      acceptsList[0];

    const verification = await verifyX402Payment(
      resolved.crypto.facilitatorUrl,
      payment,
      matchedReq,
      resolved.mode,
    );

    if (!verification.isValid) {
      return c.json(
        {
          error: "Payment verification failed",
          reason: verification.invalidReason,
        },
        402,
      );
    }

    const settlement = await settleX402Payment(
      resolved.crypto.facilitatorUrl,
      payment,
      matchedReq,
      resolved.mode,
    );

    if (!settlement.success) {
      return c.json(
        {
          error: "Payment settlement failed",
          reason: settlement.errorReason,
        },
        500,
      );
    }

    const key = generateKey(resolved.mode);
    const record: KeyRecord = {
      key,
      credits: resolved.credits.amount,
      stripeCustomerId: null,
      stripeSessionId: `crypto_${settlement.transaction}`,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    await resolved.store.set(key, record);

    return c.json({
      api_key: key,
      credits: resolved.credits.amount,
      tx_hash: settlement.transaction,
      network: settlement.network,
      payer: settlement.payer || verification.payer || "unknown",
    });
  });

  return app;
}

/**
 * Try to handle a request as a management route.
 * Returns a Response if matched, or null if no route matched.
 */
async function tryRoutes(
  routesApp: Hono,
  originalReq: Request,
  prefix: string,
): Promise<Response | null> {
  const url = new URL(originalReq.url);
  const pathname = url.pathname;

  // Check if this path is under the prefix
  let subPath: string;
  if (pathname === prefix) {
    subPath = "/";
  } else if (pathname.startsWith(prefix + "/")) {
    subPath = pathname.slice(prefix.length);
  } else {
    return null;
  }

  // Build a new request with the sub-path
  const newUrl = new URL(subPath + url.search, url.origin);
  const newReq = new Request(newUrl.toString(), {
    method: originalReq.method,
    headers: originalReq.headers,
    body: originalReq.body,
    // @ts-expect-error duplex needed for request body streaming
    duplex: "half",
  });

  const response = await routesApp.fetch(newReq);
  // Hono returns 404 for unmatched routes
  if (response.status === 404) {
    return null;
  }
  return response;
}

// --- Public API ---

/**
 * Create gate billing middleware with `.routes` and `.cost()` attached.
 *
 * ```ts
 * const g = gate({ credits: { amount: 100, price: 500 } });
 * app.use('/__gate/*', g.routes);   // management endpoints
 * app.use('/api/*', g);              // billing middleware (cost=1)
 * app.get('/api/expensive', g.cost(10), handler);
 * ```
 *
 * When mounted on a wildcard path, the middleware also intercepts
 * management routes (paths starting with routePrefix) before billing.
 */
export function gate(
  config: GateConfig,
  options?: GateMiddlewareOptions,
): GateMiddleware {
  const resolved = resolveConfig(config);
  const defaultCost = options?.cost ?? 1;
  const routesApp = buildRoutesApp(resolved);

  const billingHandler = createBillingMiddleware(resolved, defaultCost);

  // Main middleware: intercepts management routes, then falls through to billing
  const handler: MiddlewareHandler = async (c: Context, next: Next) => {
    // Check if this is a management route
    const routeResponse = await tryRoutes(
      routesApp,
      c.req.raw,
      resolved.routePrefix,
    );
    if (routeResponse) {
      return routeResponse;
    }
    // Not a management route; run billing
    return billingHandler(c, next);
  };

  // .routes middleware: for explicit mounting at routePrefix
  // When mounted via app.use("/__gate/*", g.routes), Hono passes the full URL
  // in c.req.raw, so we need to strip the mount prefix before dispatching.
  const routesHandler: MiddlewareHandler = async (c: Context, next: Next) => {
    const url = new URL(c.req.url);
    const prefix = resolved.routePrefix;
    let subPath = url.pathname;
    if (subPath.startsWith(prefix + "/")) {
      subPath = subPath.slice(prefix.length);
    } else if (subPath === prefix) {
      subPath = "/";
    }
    const newUrl = new URL(subPath + url.search, url.origin);
    const newReq = new Request(newUrl.toString(), {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      // @ts-expect-error duplex needed for request body streaming
      duplex: "half",
    });
    const response = await routesApp.fetch(newReq);
    if (response.status !== 404) {
      return response;
    }
    await next();
  };

  const gateMiddleware = handler as GateMiddleware;
  gateMiddleware.routes = routesHandler;
  gateMiddleware.cost = (n: number) => createBillingMiddleware(resolved, n);
  gateMiddleware.resolved = resolved;

  return gateMiddleware;
}

/**
 * @deprecated Use `gate()` instead. Returns `.routes` as a middleware and `.cost(n)` for per-route costs.
 */
export function mountGate(config: GateConfig) {
  const resolved = resolveConfig(config);
  const defaultMiddleware = createBillingMiddleware(resolved, 1);

  return {
    middleware: defaultMiddleware,
    gate: (options?: GateMiddlewareOptions) =>
      createBillingMiddleware(resolved, options?.cost ?? 1),
    resolved,
    routes(app: Hono) {
      // Register routes directly on the provided app (not via fetch delegation)
      // because app.route("/__gate", gateRoutes) strips the prefix from c.req.raw
      const routesApp = buildRoutesApp(resolved);

      // Mount the routes sub-app directly
      app.route("/", routesApp);
    },
  };
}
