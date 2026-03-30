import type { Request, Response, NextFunction, Router } from "express";
import { createRequire } from "node:module";
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

type ExpressMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void;

export interface GateMiddleware extends ExpressMiddleware {
  /** Express Router that handles management routes (/buy, /success, /status, /pricing, /webhook). Mount at your routePrefix. */
  routes: Router;
  /** Returns a new billing middleware with a different credit cost. */
  cost(n: number): ExpressMiddleware;
  /** The resolved configuration. */
  resolved: ResolvedConfig;
}

// --- Helpers ---

function expressHeaders(req: Request): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") h[k.toLowerCase()] = v;
  }
  return h;
}

function expressUrl(req: Request): string {
  return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

function createBillingMiddleware(
  resolved: ResolvedConfig,
  cost: number,
): ExpressMiddleware {
  return async (req: Request, res: Response, next: NextFunction) => {
    const headers = expressHeaders(req);
    const ctx = {
      apiKey: extractKeyFromRequest(headers, expressUrl(req)),
      clientType: null,
      url: expressUrl(req),
      method: req.method,
      headers,
    };

    const result = await handleGatedRequest(ctx, resolved, { cost });

    switch (result.action) {
      case "pass":
        res.setHeader("X-Gate-Credits-Remaining", String(result.remaining));
        next();
        break;
      case "pass_crypto":
        res.setHeader("X-Payment-Payer", result.payer);
        res.setHeader("X-Payment-Protocol", result.protocol);
        next();
        break;
      case "fail_open":
        next();
        break;
      case "redirect":
        res.redirect(302, result.url);
        break;
      case "payment_required": {
        res.setHeader("X-Payment-Protocol", "gate/v1");
        if (resolved.crypto) {
          const url = expressUrl(req);
          const x402 = buildX402PaymentRequired(resolved, url, cost);
          res.setHeader("PAYMENT-REQUIRED", encodePaymentRequired(x402));
          const mppChallenge = buildMppChallenge(
            {
              realm: new URL(url).hostname,
              method: "tempo",
              intent: "charge",
              amount: resolved.crypto.amountSmallestUnit,
              currency: resolved.crypto.asset,
              recipient: resolved.crypto.address,
            },
            resolved.crypto.mppSecret,
          );
          res.setHeader("WWW-Authenticate", mppChallenge);
        }
        res.status(402).json(result.body);
        break;
      }
      case "error":
        res.status(result.status).json({ error: result.message });
        break;
    }
  };
}

function buildRoutesRouter(resolved: ResolvedConfig): Router {
  const require = createRequire(import.meta.url);
  const express = require("express");
  const router: Router = express.Router();

  router.get("/buy", async (_req: Request, res: Response) => {
    try {
      const url = await createCheckoutSession(resolved);
      const accept = _req.headers.accept || "";
      if (accept.includes("application/json")) {
        return res.json({ checkout_url: url });
      }
      res.redirect(302, url);
    } catch {
      res.status(500).json({ error: "Failed to create checkout session" });
    }
  });

  router.get("/success", async (req: Request, res: Response) => {
    const sessionId =
      typeof req.query.session_id === "string"
        ? req.query.session_id
        : undefined;
    if (!sessionId) {
      return res.status(400).json({ error: "Missing session_id" });
    }
    try {
      const result = await handleCheckoutSuccess(
        sessionId,
        resolved,
        resolved.store,
      );
      if (!result) {
        return res.status(400).json({ error: "Payment not verified" });
      }
      const accept = req.headers.accept || "";
      if (accept.includes("application/json")) {
        return res.json({
          api_key: result.key,
          credits: result.record.credits,
          message: `Your API key has ${result.record.credits} credits.`,
        });
      }
      res.send(successPageHtml(result.key, result.record.credits));
    } catch {
      res.status(400).json({ error: "Payment verification failed" });
    }
  });

  router.get("/status", async (req: Request, res: Response) => {
    const headers = expressHeaders(req);
    const apiKey = extractKeyFromRequest(headers, expressUrl(req));
    if (!apiKey) {
      return res.status(401).json({ error: "API key required" });
    }
    const record = await resolved.store.get(apiKey);
    if (!record) {
      return res.status(401).json({ error: "Invalid API key" });
    }
    res.json({
      credits_remaining: record.credits,
      created_at: record.createdAt,
      last_used_at: record.lastUsedAt,
    });
  });

  router.get("/pricing", (_req: Request, res: Response) => {
    const { price, currency, amount } = resolved.credits;
    res.json({
      credits: amount,
      price,
      currency,
      formatted: `${formatPrice(price, currency)} for ${formatCredits(amount)} API calls`,
    });
  });

  router.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      const sig = req.headers["stripe-signature"];
      const signature = typeof sig === "string" ? sig : undefined;
      if (!signature) {
        return res
          .status(400)
          .json({ error: "Missing stripe-signature header" });
      }
      try {
        await handleWebhook(req.body, signature, resolved, resolved.store);
        res.json({ received: true });
      } catch (err) {
        const status = webhookErrorStatus(err);
        res.status(status).json({ error: "Webhook processing failed" });
      }
    },
  );

  router.get("/test-key", async (_req: Request, res: Response) => {
    if (resolved.mode !== "test") {
      return res.status(403).json({
        error:
          "test-key endpoint is only available in test mode (GATE_MODE=test)",
      });
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

    res.json({
      api_key: key,
      credits: resolved.credits.amount,
      mode: "test",
      message: `Test key created with ${resolved.credits.amount} credits. Use: Authorization: Bearer ${key}`,
    });
  });

  router.post("/buy-crypto", async (req: Request, res: Response) => {
    if (!resolved.crypto) {
      return res.status(404).json({ error: "Crypto payments not configured" });
    }

    const headers = expressHeaders(req);
    if (!headers["payment-signature"] && !headers["x-payment"]) {
      return res.status(400).json({
        error:
          "Missing payment. Include a payment-signature or x-payment header.",
      });
    }

    const payment = extractX402Payment(headers);
    if (!payment) {
      return res.status(400).json({ error: "Malformed payment payload" });
    }

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
      return res.status(402).json({
        error: "Payment verification failed",
        reason: verification.invalidReason,
      });
    }

    const settlement = await settleX402Payment(
      resolved.crypto.facilitatorUrl,
      payment,
      matchedReq,
      resolved.mode,
    );

    if (!settlement.success) {
      return res.status(500).json({
        error: "Payment settlement failed",
        reason: settlement.errorReason,
      });
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

    res.json({
      api_key: key,
      credits: resolved.credits.amount,
      tx_hash: settlement.transaction,
      network: settlement.network,
      payer: settlement.payer || verification.payer || "unknown",
    });
  });

  return router;
}

// --- Public API ---

/**
 * Create gate billing middleware with `.routes` and `.cost()` attached.
 *
 * ```ts
 * const g = gate({ credits: { amount: 100, price: 500 } });
 * app.use('/__gate', g.routes);     // management endpoints
 * app.use('/api', g);                // billing middleware (cost=1)
 * app.get('/api/expensive', g.cost(10), handler);
 * ```
 *
 * When used as general middleware, it also intercepts management routes
 * (paths starting with routePrefix) before running billing logic.
 */
export function gate(
  config: GateConfig,
  options?: GateMiddlewareOptions,
): GateMiddleware {
  const resolved = resolveConfig(config);
  const defaultCost = options?.cost ?? 1;
  const routesRouter = buildRoutesRouter(resolved);
  const billingHandler = createBillingMiddleware(resolved, defaultCost);

  // Main middleware: intercepts management routes, then falls through to billing
  const handler = async (req: Request, res: Response, next: NextFunction) => {
    const prefix = resolved.routePrefix; // e.g. "/__gate"
    const pathname = req.path;

    // Check if this is a management route
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      // Temporarily override req.url to strip the prefix for the router
      const originalUrl = req.url;
      req.url = pathname.slice(prefix.length) || "/";
      // Use the router as middleware
      routesRouter(req, res, (err?: unknown) => {
        // Restore original url
        req.url = originalUrl;
        if (err) {
          next(err);
        } else {
          // Router didn't match; fall through to billing
          billingHandler(req, res, next);
        }
      });
      return;
    }

    // Not a management route; run billing
    billingHandler(req, res, next);
  };

  const gateMiddleware = handler as unknown as GateMiddleware;
  gateMiddleware.routes = routesRouter;
  gateMiddleware.cost = (n: number) => createBillingMiddleware(resolved, n);
  gateMiddleware.resolved = resolved;

  return gateMiddleware;
}

/**
 * @deprecated Use `gate()` instead. Returns `.routes` as a Router and `.cost(n)` for per-route costs.
 */
export function mountGate(config: GateConfig) {
  const resolved = resolveConfig(config);
  const defaultMiddleware = createBillingMiddleware(resolved, 1);

  return {
    middleware: defaultMiddleware,
    gate: (options?: GateMiddlewareOptions) =>
      createBillingMiddleware(resolved, options?.cost ?? 1),
    resolved,
    routes(): Router {
      return buildRoutesRouter(resolved);
    },
  };
}
