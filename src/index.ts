export { resolveConfig } from "./config.js";
export { handleGatedRequest } from "./core.js";
export { classifyClient } from "./detect.js";
export {
  paymentRequired,
  creditsExhausted,
  GateConfigError,
} from "./errors.js";
export { generateKey, parseKey, extractKeyFromRequest } from "./keys.js";
export {
  createCheckoutSession,
  handleCheckoutSuccess,
  handleWebhook,
} from "./stripe.js";

export { MemoryStore } from "./store/memory.js";
export { RedisStore } from "./store/redis.js";
export type {
  GateCredits,
  GateStripeConfig,
  GateConfig,
  ResolvedConfig,
  KeyRecord,
  CreditStore,
  DecrementResult,
  ClientType,
  GateResponse402,
  GateRequestContext,
  GateResult,
} from "./types.js";
export type { RedisLikeClient, RedisStoreOptions } from "./store/redis.js";
