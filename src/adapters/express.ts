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
