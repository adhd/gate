# Ticket 5: Adapter 402 headers for crypto payments

## Project context

`gate` (npm: `@daviejpg/gate-pay`) is a middleware that adds pay-per-call billing to APIs. It supports Stripe Checkout for human customers and returns 402 JSON for API clients. The codebase is TypeScript, uses Hono and Express adapters, has 76 tests passing, and one runtime dependency (stripe).

We are adding x402 and MPP crypto payment support so AI agents can pay USDC per-call without Stripe Checkout. Tickets 1-4 are already merged. Ticket 1 added crypto types and config. Ticket 2 added `src/crypto/x402.ts` with `buildX402PaymentRequired`, `encodePaymentRequired`, and the facilitator client. Ticket 3 added `src/crypto/mpp.ts` with `buildMppChallenge` and `verifyMppCredential`. Ticket 4 wired both into `src/core.ts` so `handleGatedRequest` returns `pass_crypto` for valid crypto payments and includes crypto info in 402 response bodies.

This ticket adds the protocol headers to 402 responses in both adapters and handles the new `pass_crypto` result variant.

GitHub: https://github.com/adhd/gate
Branch: `feat/crypto-headers`

## What to do

Modify both the Hono and Express adapters to:

1. Handle the `pass_crypto` GateResult variant (set payer/protocol response headers, then continue to the route handler).
2. When the `payment_required` case fires and `resolved.crypto` is configured, attach two additional headers to the 402 response:
   - `PAYMENT-REQUIRED`: base64-encoded x402 PaymentRequired object (for x402-aware clients).
   - `WWW-Authenticate`: MPP Payment challenge string (for MPP-aware clients).

These headers let AI agent clients detect the payment options from a single 402 response and retry with the protocol they support.

## Changes

### 1. `src/adapters/hono.ts`

Replace the entire file with this version. Changes from the current file: new imports for crypto modules, new `pass_crypto` case in the switch, and crypto headers added to the `payment_required` case.

```typescript
import type { MiddlewareHandler, Hono } from "hono";
import type {
  GateConfig,
  GateMiddlewareOptions,
  ResolvedConfig,
} from "../types.js";
import { resolveConfig } from "../config.js";
import { handleGatedRequest } from "../core.js";
import { extractKeyFromRequest } from "../keys.js";
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
} from "../crypto/x402.js";
import { buildMppChallenge } from "../crypto/mpp.js";

function honoHeaders(c: {
  req: { raw: { headers: Headers } };
}): Record<string, string> {
  const h: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    h[k.toLowerCase()] = v;
  });
  return h;
}

function createMiddleware(
  resolved: ResolvedConfig,
  cost: number,
): MiddlewareHandler {
  return async (c, next) => {
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

export function gate(
  config: GateConfig,
  options?: GateMiddlewareOptions,
): MiddlewareHandler {
  const resolved = resolveConfig(config);
  return createMiddleware(resolved, options?.cost ?? 1);
}

export function mountGate(config: GateConfig) {
  const resolved = resolveConfig(config);
  const defaultMiddleware = createMiddleware(resolved, 1);

  return {
    middleware: defaultMiddleware,
    gate: (options?: GateMiddlewareOptions) =>
      createMiddleware(resolved, options?.cost ?? 1),
    resolved,
    routes(app: Hono) {
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
    },
  };
}
```

### 2. `src/adapters/express.ts`

Replace the entire file with this version. Same pattern: new imports, new `pass_crypto` case, crypto headers on `payment_required`.

```typescript
import type { Request, Response, NextFunction, Router } from "express";
import { createRequire } from "node:module";
import type {
  GateConfig,
  GateMiddlewareOptions,
  ResolvedConfig,
} from "../types.js";
import { resolveConfig } from "../config.js";
import { handleGatedRequest } from "../core.js";
import { extractKeyFromRequest } from "../keys.js";
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
} from "../crypto/x402.js";
import { buildMppChallenge } from "../crypto/mpp.js";

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

function createMiddleware(resolved: ResolvedConfig, cost: number) {
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

export function gate(config: GateConfig, options?: GateMiddlewareOptions) {
  const resolved = resolveConfig(config);
  return createMiddleware(resolved, options?.cost ?? 1);
}

export function mountGate(config: GateConfig) {
  const resolved = resolveConfig(config);
  const defaultMiddleware = createMiddleware(resolved, 1);

  return {
    middleware: defaultMiddleware,
    gate: (options?: GateMiddlewareOptions) =>
      createMiddleware(resolved, options?.cost ?? 1),
    resolved,
    routes(): Router {
      const require = createRequire(import.meta.url);
      const express = require("express");
      const router = express.Router();

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

      return router;
    },
  };
}
```

### 3. Tests to add in `test/integration/hono.test.ts`

Add these tests inside the existing `describe("hono adapter integration", ...)` block, after the current tests:

```typescript
describe("crypto headers", () => {
  function buildCryptoApp() {
    const app = new Hono();
    const billing = mountGate({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
      },
    });

    app.use("/api/*", billing.middleware);
    app.get("/api/data", (c) => c.json({ ok: true }));

    const gateRoutes = new Hono();
    billing.routes(gateRoutes);
    app.route("/__gate", gateRoutes);

    return { app, billing };
  }

  it("402 includes PAYMENT-REQUIRED header when crypto configured", async () => {
    const { app } = buildCryptoApp();

    const res = await app.request("http://localhost/api/data", {
      headers: { accept: "application/json", "user-agent": "curl/8.0" },
    });

    expect(res.status).toBe(402);
    const pr = res.headers.get("payment-required");
    expect(pr).toBeTruthy();

    // Decode and verify structure
    const decoded = JSON.parse(atob(pr!));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toBeInstanceOf(Array);
    expect(decoded.accepts[0].payTo).toBe("0x" + "a".repeat(40));
    expect(decoded.accepts[0].amount).toBe("5000");
  });

  it("402 includes WWW-Authenticate: Payment header when crypto configured", async () => {
    const { app } = buildCryptoApp();

    const res = await app.request("http://localhost/api/data", {
      headers: { accept: "application/json", "user-agent": "curl/8.0" },
    });

    expect(res.status).toBe(402);
    const wwwAuth = res.headers.get("www-authenticate");
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toContain("Payment ");
    expect(wwwAuth).toContain('method="tempo"');
    expect(wwwAuth).toContain('intent="charge"');
  });

  it("402 omits crypto headers when crypto not configured", async () => {
    const { app } = buildHonoApp();

    const res = await app.request("http://localhost/api/data", {
      headers: { accept: "application/json", "user-agent": "curl/8.0" },
    });

    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(res.headers.get("x-payment-protocol")).toBe("gate/v1");
  });
});
```

### 4. Tests to add in `test/integration/express.test.ts`

Add these tests inside the existing `describe("express adapter integration", ...)` block, after the current tests:

```typescript
describe("crypto headers", () => {
  function buildCryptoApp() {
    const app = express();
    const billing = mountGate({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
      },
    });

    app.use("/__gate", billing.routes());
    app.use(express.json());
    app.use("/api", billing.middleware);
    app.get("/api/data", (_req, res) => res.json({ ok: true }));

    return { app, billing };
  }

  it("402 includes PAYMENT-REQUIRED header when crypto configured", async () => {
    const { app } = buildCryptoApp();

    const res = await request(app)
      .get("/api/data")
      .set("accept", "application/json")
      .set("user-agent", "curl/8.0");

    expect(res.status).toBe(402);
    const pr = res.headers["payment-required"];
    expect(pr).toBeTruthy();

    const decoded = JSON.parse(atob(pr));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toBeInstanceOf(Array);
    expect(decoded.accepts[0].payTo).toBe("0x" + "a".repeat(40));
    expect(decoded.accepts[0].amount).toBe("5000");
  });

  it("402 includes WWW-Authenticate: Payment header when crypto configured", async () => {
    const { app } = buildCryptoApp();

    const res = await request(app)
      .get("/api/data")
      .set("accept", "application/json")
      .set("user-agent", "curl/8.0");

    expect(res.status).toBe(402);
    const wwwAuth = res.headers["www-authenticate"];
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toContain("Payment ");
    expect(wwwAuth).toContain('method="tempo"');
    expect(wwwAuth).toContain('intent="charge"');
  });

  it("402 omits crypto headers when crypto not configured", async () => {
    const { app } = buildExpressApp();

    const res = await request(app)
      .get("/api/data")
      .set("accept", "application/json")
      .set("user-agent", "curl/8.0");

    expect(res.status).toBe(402);
    expect(res.headers["payment-required"]).toBeUndefined();
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });
});
```

## Acceptance criteria

- `npx tsc --noEmit` passes
- `npm test` passes (all existing tests plus new crypto header tests)
- `npm run build` succeeds
- No new entries in `dependencies` in package.json
- 402 responses include `PAYMENT-REQUIRED` and `WWW-Authenticate` headers when `crypto` is configured
- 402 responses omit those headers when `crypto` is not configured (existing behavior preserved)
- `pass_crypto` result sets `X-Payment-Payer` and `X-Payment-Protocol` response headers and continues to the route handler
- The JSON body of 402 responses is unchanged (crypto info in body was handled by Ticket 4)
