import type { MiddlewareHandler, Hono } from "hono";
import type { GateConfig, ResolvedConfig } from "../types.js";
import { resolveConfig } from "../config.js";
import { handleGatedRequest } from "../core.js";
import { extractKeyFromRequest } from "../keys.js";
import { classifyClient } from "../detect.js";
import { handleCheckoutSuccess, handleWebhook } from "../stripe.js";

function createMiddleware(resolved: ResolvedConfig): MiddlewareHandler {
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

    const result = await handleGatedRequest(ctx, resolved);

    switch (result.action) {
      case "pass":
      case "fail_open":
        c.set("gate" as never, result);
        await next();
        break;
      case "redirect":
        return c.redirect(result.url, 302);
      case "payment_required":
        return c.json(result.body, 402);
      case "error":
        return c.json({ error: result.message }, result.status as 401 | 503);
    }
  };
}

export function gate(config: GateConfig): MiddlewareHandler {
  return createMiddleware(resolveConfig(config));
}

export function mountGate(config: GateConfig) {
  const resolved = resolveConfig(config);
  const middleware = createMiddleware(resolved);

  return {
    middleware,
    resolved,
    /** Create route handlers for /__gate/success and /__gate/webhook */
    routes(app: Hono) {
      app.get("/success", async (c) => {
        const sessionId = c.req.query("session_id");
        if (!sessionId) {
          return c.json({ error: "Missing session_id" }, 400);
        }

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

        // HTML response for browsers
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
          return c.json({ error: "Webhook verification failed" }, 400);
        }
      });
    },
  };
}
