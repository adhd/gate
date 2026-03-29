import type { Request, Response, NextFunction, Router } from "express";
import { createRequire } from "node:module";
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

const require = createRequire(import.meta.url);

export interface GateMiddlewareOptions {
  cost?: number;
}

function createMiddleware(resolved: ResolvedConfig, cost: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }

    const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    const ctx = {
      apiKey: extractKeyFromRequest(headers, url),
      clientType: classifyClient(headers),
      url,
      method: req.method,
      headers,
    };

    const result = await handleGatedRequest(ctx, resolved, { cost });

    switch (result.action) {
      case "pass":
        res.setHeader(
          "X-Gate-Credits-Remaining",
          String(result.keyRecord.credits),
        );
        (req as any).gate = result;
        next();
        break;
      case "fail_open":
        next();
        break;
      case "redirect":
        res.redirect(302, result.url);
        break;
      case "payment_required":
        res.setHeader("X-Payment-Protocol", "gate/v1");
        res.status(402).json(result.body);
        break;
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
        const sessionId = req.query.session_id as string;
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

          res.send(`<!DOCTYPE html>
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
          res.status(400).json({ error: "Payment verification failed" });
        }
      });

      router.get("/key", async (req: Request, res: Response) => {
        const sessionId = req.query.session_id as string;
        if (!sessionId) {
          return res.status(400).json({ error: "Missing session_id" });
        }

        const record = await resolved.store.get(`session:${sessionId}`);
        if (!record) {
          return res
            .status(404)
            .json({ error: "No key found for this session" });
        }

        res.json({ api_key: record.key, credits: record.credits });
      });

      router.get("/status", async (req: Request, res: Response) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers[k.toLowerCase()] = v;
        }
        const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
        const apiKey = extractKeyFromRequest(headers, url);
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
        const price = resolved.credits.price;
        res.json({
          credits: resolved.credits.amount,
          price,
          currency: resolved.credits.currency,
          formatted: `$${(price / 100).toFixed(2)} for ${resolved.credits.amount.toLocaleString("en-US")} API calls`,
        });
      });

      router.post(
        "/webhook",
        express.raw({ type: "application/json" }),
        async (req: Request, res: Response) => {
          const signature = req.headers["stripe-signature"] as string;
          if (!signature) {
            return res
              .status(400)
              .json({ error: "Missing stripe-signature header" });
          }

          try {
            await handleWebhook(req.body, signature, resolved, resolved.store);
            res.json({ received: true });
          } catch {
            res.status(400).json({ error: "Webhook verification failed" });
          }
        },
      );

      return router;
    },
  };
}
