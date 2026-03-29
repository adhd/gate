import type {
  GateResult,
  GateRequestContext,
  ResolvedConfig,
} from "./types.js";
import { extractKeyFromRequest } from "./keys.js";
import { classifyClient } from "./detect.js";
import { paymentRequired, creditsExhausted } from "./errors.js";

export async function handleGatedRequest(
  ctx: GateRequestContext,
  config: ResolvedConfig,
  options?: { cost?: number },
): Promise<GateResult> {
  const { store, failMode } = config;
  const cost = options?.cost ?? 1;

  // 1. Extract API key
  const apiKey = ctx.apiKey ?? extractKeyFromRequest(ctx.headers, ctx.url);

  // 2. If key present, attempt atomic decrement (no separate get)
  if (apiKey) {
    try {
      const result = await store.decrement(apiKey, cost);

      switch (result.status) {
        case "ok":
          return {
            action: "pass",
            keyRecord: {
              key: apiKey,
              credits: result.remaining,
              stripeCustomerId: null,
              stripeSessionId: "",
              createdAt: "",
              lastUsedAt: null,
            },
          };
        case "not_found":
          return { action: "error", status: 401, message: "Invalid API key" };
        case "exhausted": {
          const purchaseUrl = buildPurchaseUrl(config, ctx);
          return {
            action: "payment_required",
            body: creditsExhausted(config, purchaseUrl, apiKey),
            status: 402,
          };
        }
      }
    } catch {
      if (failMode === "open") return { action: "fail_open" };
      return {
        action: "error",
        status: 503,
        message: "Service temporarily unavailable",
      };
    }
  }

  // 3. No key: respond based on client type
  const purchaseUrl = buildPurchaseUrl(config, ctx);
  const clientType = ctx.clientType ?? classifyClient(ctx.headers);

  if (clientType === "browser") {
    return { action: "redirect", url: purchaseUrl };
  }

  return {
    action: "payment_required",
    body: paymentRequired(config, purchaseUrl),
    status: 402,
  };
}

/** Build a stable purchase URL (no Stripe session created here). */
function buildPurchaseUrl(
  config: ResolvedConfig,
  ctx: GateRequestContext,
): string {
  if (config.mode === "test") {
    return `https://gate.test/buy`;
  }
  const base =
    config.baseUrl ??
    `${ctx.headers["x-forwarded-proto"] || "https"}://${ctx.headers["host"]}`;
  return `${base}${config.routePrefix}/buy`;
}
