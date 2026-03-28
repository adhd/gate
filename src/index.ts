export { resolveConfig } from "./config.js";
export { handleGatedRequest } from "./core.js";
export { classifyClient } from "./detect.js";
export { paymentRequired, creditsExhausted, GateConfigError } from "./errors.js";
export { generateKey, parseKey, extractKeyFromRequest } from "./keys.js";
export { createCheckoutUrl, handleCheckoutSuccess, handleWebhook } from "./stripe.js";

export { MemoryStore } from "./store/memory.js";
export type {
  GateCredits,
  GateStripeConfig,
  GateConfig,
  ResolvedConfig,
  KeyRecord,
  CreditStore,
  ClientType,
  GateResponse402,
  GateRequestContext,
  GateResult,
} from "./types.js";
