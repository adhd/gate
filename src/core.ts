import type {
  GateResult,
  GateRequestContext,
  ResolvedConfig,
} from "./types.js";
import { extractKeyFromRequest } from "./keys.js";
import { classifyClient } from "./detect.js";
import { paymentRequired, creditsExhausted } from "./errors.js";
import {
  hasX402Payment,
  extractX402Payment,
  verifyX402Payment,
  settleX402Payment,
  buildX402PaymentRequired,
} from "./crypto/x402.js";
import { hasMppPayment, verifyMppCredential } from "./crypto/mpp.js";

export async function handleGatedRequest(
  ctx: GateRequestContext,
  config: ResolvedConfig,
  options?: { cost?: number },
): Promise<GateResult> {
  const { store, failMode } = config;
  const cost = options?.cost ?? 1;

  // --- Crypto payment check (runs BEFORE key check) ---
  if (config.crypto) {
    // x402 protocol check
    if (hasX402Payment(ctx.headers)) {
      const payment = extractX402Payment(ctx.headers);
      if (payment) {
        const requirements = buildX402PaymentRequired(config, ctx.url, cost);
        const matchedReq =
          requirements.accepts.find(
            (a) => a.network === payment.accepted?.network,
          ) || requirements.accepts[0];

        const verification = await verifyX402Payment(
          config.crypto.facilitatorUrl,
          payment,
          matchedReq,
          config.mode,
        );

        if (verification.isValid) {
          // Settle the payment on-chain (fire and forget, don't block response)
          settleX402Payment(
            config.crypto.facilitatorUrl,
            payment,
            matchedReq,
            config.mode,
          ).catch((err) =>
            console.error("[gate] x402 settlement failed:", err),
          );

          return {
            action: "pass_crypto",
            payer: verification.payer || "unknown",
            protocol: "x402",
          };
        }
        return {
          action: "error",
          status: 402,
          message: verification.invalidReason || "Payment verification failed",
        };
      }
    }

    // MPP protocol check
    if (hasMppPayment(ctx.headers)) {
      const auth = ctx.headers["authorization"] || "";
      const result = verifyMppCredential(auth, config.crypto.mppSecret);
      if (result.valid) {
        return {
          action: "pass_crypto",
          payer: result.payer || "unknown",
          protocol: "mpp",
          txHash: (result.payload?.hash as string) || undefined,
        };
      }
      return {
        action: "error",
        status: 402,
        message: result.error || "Payment verification failed",
      };
    }
  }

  // --- API key check ---
  const apiKey = ctx.apiKey ?? extractKeyFromRequest(ctx.headers, ctx.url);

  if (apiKey) {
    try {
      const result = await store.decrement(apiKey, cost);

      switch (result.status) {
        case "ok":
          return { action: "pass", key: apiKey, remaining: result.remaining };
        case "not_found":
          return { action: "error", status: 401, message: "Invalid API key" };
        case "exhausted": {
          const purchaseUrl = buildPurchaseUrl(config, ctx);
          return {
            action: "payment_required",
            body: creditsExhausted(config, purchaseUrl, apiKey, config.crypto),
            status: 402,
          };
        }
      }
    } catch (err) {
      console.error("[gate] Store error:", err);
      if (failMode === "open") return { action: "fail_open" };
      return {
        action: "error",
        status: 503,
        message: "Service temporarily unavailable",
      };
    }
  }

  // --- No key, no crypto payment ---
  const purchaseUrl = buildPurchaseUrl(config, ctx);
  const clientType = ctx.clientType ?? classifyClient(ctx.headers);

  if (clientType === "browser") {
    return { action: "redirect", url: purchaseUrl };
  }

  return {
    action: "payment_required",
    body: paymentRequired(config, purchaseUrl, config.crypto),
    status: 402,
  };
}

function buildPurchaseUrl(
  config: ResolvedConfig,
  ctx: GateRequestContext,
): string {
  if (config.mode === "test") {
    return "https://gate.test/buy";
  }
  const base =
    config.baseUrl ??
    `${ctx.headers["x-forwarded-proto"] || "https"}://${ctx.headers["host"]}`;
  return `${base}${config.routePrefix}/buy`;
}
