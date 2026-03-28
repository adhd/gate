import type { GateConfig, ResolvedConfig } from "./types.js";
import { MemoryStore } from "./store/memory.js";
import { GateConfigError } from "./errors.js";

export function resolveConfig(input: GateConfig): ResolvedConfig {
  const mode = (process.env.GATE_MODE === "test" ? "test" : "live") as
    | "live"
    | "test";

  // Validate credits
  if (
    !input.credits ||
    typeof input.credits.amount !== "number" ||
    input.credits.amount <= 0
  ) {
    throw new GateConfigError("credits.amount must be a positive number");
  }
  if (typeof input.credits.price !== "number" || input.credits.price <= 0) {
    throw new GateConfigError(
      "credits.price must be a positive number (in cents)",
    );
  }

  // Resolve Stripe config
  const secretKey =
    input.stripe?.secretKey || process.env.STRIPE_SECRET_KEY || "";
  const webhookSecret =
    input.stripe?.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET || "";

  if (mode === "live" && !secretKey) {
    throw new GateConfigError(
      "Stripe secret key required. Set stripe.secretKey in config or STRIPE_SECRET_KEY env var.",
    );
  }
  if (mode === "live" && !webhookSecret) {
    throw new GateConfigError(
      "Stripe webhook secret required. Set stripe.webhookSecret in config or STRIPE_WEBHOOK_SECRET env var.",
    );
  }

  return {
    credits: {
      amount: input.credits.amount,
      price: input.credits.price,
      currency: input.credits.currency || "usd",
    },
    stripe: {
      secretKey,
      webhookSecret,
      connectId: input.stripe?.connectId || null,
      applicationFeePercent: 5,
    },
    store: input.store || new MemoryStore(),
    failMode: input.failMode || "open",
    baseUrl: input.baseUrl || null,
    productName: input.productName || "API Access",
    productDescription: input.productDescription || "",
    mode,
  };
}
