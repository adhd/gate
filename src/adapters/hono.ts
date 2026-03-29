import type { MiddlewareHandler, Hono } from "hono";
import type { GateConfig, ResolvedConfig } from "../types.js";
import { resolveConfig } from "../config.js";
import { handleGatedRequest } from "../core.js";
import { extractKeyFromRequest } from "../keys.js";
import { classifyClient } from "../detect.js";
import {
  createCheckoutSession,
  handleCheckoutSuccess,
  handleWebhook,
} from "../stripe.js";

export interface GateMiddlewareOptions {
  /** Credit cost for this route. Default: 1. */
  cost?: number;
}

function createMiddleware(
  resolved: ResolvedConfig,
  cost: number,
): MiddlewareHandler {
  return async (c, next) => {
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });

    const ctx = {
      apiKey: extractKeyFromRequest(headers, c.req.url),
      clientType: classifyClient(headers),
      url: c.req.url,
      method: c.req.method,
      headers,
    };

    const result = await handleGatedRequest(ctx, resolved, { cost });

    switch (result.action) {
      case "pass":
        c.header("X-Gate-Credits-Remaining", String(result.keyRecord.credits));
        await next();
        break;
      case "fail_open":
        await next();
        break;
      case "redirect":
        return c.redirect(result.url, 302);
      case "payment_required":
        c.header("X-Payment-Protocol", "gate/v1");
        return c.json(result.body, 402);
      case "error":
        return c.json({ error: result.message }, result.status as 401 | 503);
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
      // Buy: creates Stripe Checkout on demand (not per-402)
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

      // Success: verify payment, issue key
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

          return c.html(`<!DOCTYPE html>
<html><head><title>API Key Created</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:0 20px}
code{background:#f0f0f0;padding:4px 8px;border-radius:4px;font-size:14px;display:block;margin:12px 0;word-break:break-all}</style>
</head><body>
<h1>Your API Key</h1>
<p>Use this key to authenticate your API requests:</p>
<code>${result.key}</code>
<p>You have <strong>${result.record.credits}</strong> credits remaining.</p>
<p>Include it as: <code>Authorization: Bearer ${result.key}</code></p>
</body></html>`);
        } catch {
          return c.json({ error: "Payment verification failed" }, 400);
        }
      });

      // Key retrieval by session ID
      app.get("/key", async (c) => {
        const sessionId = c.req.query("session_id");
        if (!sessionId) {
          return c.json({ error: "Missing session_id" }, 400);
        }

        const record = await resolved.store.get(`session:${sessionId}`);
        if (!record) {
          return c.json({ error: "No key found for this session" }, 404);
        }

        return c.json({ api_key: record.key, credits: record.credits });
      });

      // Status: check balance (requires API key)
      app.get("/status", async (c) => {
        const headers: Record<string, string> = {};
        c.req.raw.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        const apiKey = extractKeyFromRequest(headers, c.req.url);
        if (!apiKey) {
          return c.json({ error: "API key required" }, 401);
        }

        const record = await resolved.store.get(apiKey);
        if (!record) {
          return c.json({ error: "Invalid API key" }, 401);
        }

        return c.json({
          credits_remaining: record.credits,
          created_at: record.createdAt,
          last_used_at: record.lastUsedAt,
        });
      });

      // Pricing (no auth needed)
      app.get("/pricing", (c) => {
        const price = resolved.credits.price;
        const currency = resolved.credits.currency;
        return c.json({
          credits: resolved.credits.amount,
          price,
          currency,
          formatted: `$${(price / 100).toFixed(2)} for ${resolved.credits.amount.toLocaleString("en-US")} API calls`,
        });
      });

      // Webhook
      app.post("/webhook", async (c) => {
        const body = await c.req.text();
        const signature = c.req.header("stripe-signature");
        if (!signature) {
          return c.json({ error: "Missing stripe-signature header" }, 400);
        }

        try {
          await handleWebhook(body, signature, resolved, resolved.store);
          return c.json({ received: true });
        } catch {
          return c.json({ error: "Webhook verification failed" }, 400);
        }
      });
    },
  };
}
