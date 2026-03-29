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
      case "fail_open":
        await next();
        break;
      case "redirect":
        return c.redirect(result.url, 302);
      case "payment_required":
        c.header("X-Payment-Protocol", "gate/v1");
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
