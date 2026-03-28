import type {
  GateResult,
  GateRequestContext,
  ResolvedConfig,
} from "./types.js";
import { extractKeyFromRequest } from "./keys.js";
import { classifyClient } from "./detect.js";
import { paymentRequired, creditsExhausted } from "./errors.js";
import { createCheckoutUrl } from "./stripe.js";

export async function handleGatedRequest(
  ctx: GateRequestContext,
  config: ResolvedConfig,
): Promise<GateResult> {
  const { store, failMode } = config;

  // 1. Extract API key
  const apiKey = ctx.apiKey ?? extractKeyFromRequest(ctx.headers, ctx.url);

  // 2. If key present, validate and decrement
  if (apiKey) {
    try {
      const record = await store.get(apiKey);

      if (!record) {
        return { action: "error", status: 401, message: "Invalid API key" };
      }

      if (record.credits <= 0) {
        const checkoutUrl = await createCheckoutUrl(config, ctx);
        return {
          action: "payment_required",
          body: creditsExhausted(config, checkoutUrl),
          status: 402,
        };
      }

      const remaining = await store.decrement(apiKey);
      if (remaining === null) {
        const checkoutUrl = await createCheckoutUrl(config, ctx);
        return {
          action: "payment_required",
          body: creditsExhausted(config, checkoutUrl),
          status: 402,
        };
      }

      return { action: "pass", keyRecord: { ...record, credits: remaining } };
    } catch (err) {
      // Store unreachable
      if (failMode === "open") {
        return { action: "fail_open" };
      }
      return {
        action: "error",
        status: 503,
        message: "Service temporarily unavailable",
      };
    }
  }

  // 3. No key: create checkout and respond based on client type
  try {
    const checkoutUrl = await createCheckoutUrl(config, ctx);
    const clientType = ctx.clientType ?? classifyClient(ctx.headers);

    if (clientType === "browser") {
      return { action: "redirect", url: checkoutUrl };
    }

    return {
      action: "payment_required",
      body: paymentRequired(config, checkoutUrl),
      status: 402,
    };
  } catch (err) {
    if (failMode === "open") {
      return { action: "fail_open" };
    }
    return {
      action: "error",
      status: 503,
      message: "Service temporarily unavailable",
    };
  }
}
