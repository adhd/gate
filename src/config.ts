import crypto from "node:crypto";
import type { GateConfig, ResolvedConfig } from "./types.js";
import { MemoryStore } from "./store/memory.js";
import { GateConfigError } from "./errors.js";

const NETWORK_MAP: Record<string, string> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
};

const USDC_ADDRESSES: Record<string, string> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export function resolveConfig(input: GateConfig): ResolvedConfig {
  const mode = (
    process.env.GATE_MODE === "test" ? "test" : "live"
  ) as ResolvedConfig["mode"];

  if (
    mode === "test" &&
    process.env.NODE_ENV === "production" &&
    process.env.GATE_ALLOW_TEST_IN_PRODUCTION !== "true"
  ) {
    throw new GateConfigError(
      "GATE_MODE=test cannot be used when NODE_ENV=production. Remove GATE_MODE or set GATE_ALLOW_TEST_IN_PRODUCTION=true to override.",
    );
  }

  // Validate credits
  if (
    !input.credits ||
    typeof input.credits.amount !== "number" ||
    !Number.isFinite(input.credits.amount) ||
    input.credits.amount <= 0
  ) {
    throw new GateConfigError("credits.amount must be a positive number");
  }
  if (
    typeof input.credits.price !== "number" ||
    !Number.isFinite(input.credits.price) ||
    input.credits.price <= 0
  ) {
    throw new GateConfigError(
      "credits.price must be a positive number (in cents)",
    );
  }

  // Resolve Stripe config
  const secretKey =
    input.stripe?.secretKey || process.env.STRIPE_SECRET_KEY || "";
  const webhookSecret =
    input.stripe?.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET || "";

  const hasCrypto = !!input.crypto;
  const hasStripe = !!(secretKey && webhookSecret);

  if (mode === "live" && !hasStripe && !hasCrypto) {
    throw new GateConfigError(
      "Either Stripe or crypto config is required in live mode. Set stripe keys or provide crypto config.",
    );
  }

  // Require baseUrl in live mode
  if (mode === "live" && !input.baseUrl) {
    throw new GateConfigError(
      "baseUrl is required in live mode. Set it to your public URL (e.g. https://api.example.com).",
    );
  }

  // Resolve crypto config
  let resolvedCrypto: ResolvedConfig["crypto"] = null;
  if (input.crypto) {
    const {
      address,
      pricePerCall,
      networks,
      facilitatorUrl,
      mppSecret,
      asset,
    } = input.crypto;

    // Validate address
    if (
      typeof address !== "string" ||
      !address.startsWith("0x") ||
      address.length !== 42
    ) {
      throw new GateConfigError(
        "crypto.address must be a valid Ethereum address (0x + 40 hex chars)",
      );
    }

    // Validate pricePerCall
    if (
      typeof pricePerCall !== "number" ||
      !Number.isFinite(pricePerCall) ||
      pricePerCall <= 0
    ) {
      throw new GateConfigError(
        "crypto.pricePerCall must be a positive finite number",
      );
    }

    // Resolve mppSecret
    let resolvedMppSecret = mppSecret || process.env.GATE_MPP_SECRET || "";
    if (!resolvedMppSecret) {
      if (mode === "test") {
        resolvedMppSecret = crypto.randomBytes(32).toString("hex");
      } else {
        throw new GateConfigError(
          "crypto.mppSecret is required. Set it in config or GATE_MPP_SECRET env var.",
        );
      }
    }

    // Map networks to CAIP-2
    const rawNetworks = networks || ["base"];
    const resolvedNetworks = rawNetworks.map((n) =>
      n.includes(":") ? n : NETWORK_MAP[n] || n,
    );

    const assetDecimals = 6;
    const amountSmallestUnit = Math.round(
      pricePerCall * Math.pow(10, assetDecimals),
    ).toString();

    // Resolve asset address from first network if not provided
    const resolvedAsset = asset || USDC_ADDRESSES[resolvedNetworks[0]] || "";

    const resolvedFacilitatorUrl =
      mode === "test"
        ? "https://gate.test/facilitator"
        : facilitatorUrl || "https://x402.org/facilitator";

    resolvedCrypto = {
      address,
      pricePerCallUsd: pricePerCall,
      amountSmallestUnit,
      networks: resolvedNetworks,
      facilitatorUrl: resolvedFacilitatorUrl,
      mppSecret: resolvedMppSecret,
      asset: resolvedAsset,
      assetDecimals,
    };
  }

  const store = input.store || new MemoryStore();

  // Warn about MemoryStore in live mode
  if (mode === "live" && store instanceof MemoryStore) {
    console.warn(
      "[gate] Warning: using in-memory store in live mode. Keys and credits will be lost on restart. Use RedisStore or a custom store for production.",
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
    },
    crypto: resolvedCrypto,
    store,
    failMode: input.failMode || "open",
    baseUrl: input.baseUrl || null,
    routePrefix: input.routePrefix || "/__gate",
    productName: input.productName || "API Access",
    productDescription: input.productDescription || "",
    mode,
  };
}
