import { describe, expect, it } from "vitest";
import {
  paymentRequired,
  creditsExhausted,
  GateConfigError,
} from "../src/errors.js";
import type { ResolvedConfig } from "../src/types.js";
import { MemoryStore } from "../src/store/memory.js";

function makeConfig(
  overrides: Partial<ResolvedConfig["credits"]> = {},
): ResolvedConfig {
  return {
    credits: {
      amount: 1000,
      price: 500,
      currency: "usd",
      ...overrides,
    },
    stripe: { secretKey: "sk_test_xxx", webhookSecret: "whsec_xxx" },
    store: new MemoryStore(),
    failMode: "open",
    baseUrl: null,
    routePrefix: "/__gate",
    productName: "API Access",
    productDescription: "",
    mode: "test",
  };
}

describe("paymentRequired", () => {
  it("returns correct structure with all fields", () => {
    const config = makeConfig();
    const result = paymentRequired(config, "https://example.com/__gate/buy");

    expect(result.error).toBe("payment_required");
    expect(result.message).toContain("1,000");
    expect(result.message).toContain("$5.00");
    expect(result.payment.type).toBe("checkout");
    expect(result.payment.provider).toBe("stripe");
    expect(result.payment.purchase_url).toBe("https://example.com/__gate/buy");
    expect(result.payment.pricing).toEqual({
      amount: 500,
      currency: "usd",
      credits: 1000,
      formatted: "$5.00 for 1,000 API calls",
    });
    // No key field on payment_required
    expect(result.key).toBeUndefined();
  });

  it("formats non-USD currency correctly", () => {
    const config = makeConfig({ currency: "eur", price: 800 });
    const result = paymentRequired(config, "https://example.com/buy");

    expect(result.message).toContain("8.00 EUR");
    expect(result.payment.pricing.currency).toBe("eur");
    expect(result.payment.pricing.formatted).toContain("8.00 EUR");
  });
});

describe("creditsExhausted", () => {
  it("returns correct structure with key mask", () => {
    const config = makeConfig();
    const apiKey = "gate_test_" + "a".repeat(32);
    const result = creditsExhausted(
      config,
      "https://example.com/__gate/buy",
      apiKey,
    );

    expect(result.error).toBe("credits_exhausted");
    expect(result.message).toContain("no remaining credits");
    expect(result.payment.type).toBe("checkout");
    expect(result.payment.provider).toBe("stripe");
    expect(result.key).toBeDefined();
    expect(result.key!.credits_remaining).toBe(0);
    // Key should be masked: first 10 chars + "..." + last 4 chars
    expect(result.key!.id).toBe(apiKey.slice(0, 10) + "..." + apiKey.slice(-4));
  });

  it("omits key field when apiKey is not provided", () => {
    const config = makeConfig();
    const result = creditsExhausted(config, "https://example.com/__gate/buy");

    expect(result.error).toBe("credits_exhausted");
    expect(result.key).toBeUndefined();
  });

  it("does not mask short keys (14 chars or fewer)", () => {
    const config = makeConfig();
    const shortKey = "gate_test_1234"; // exactly 14 chars
    const result = creditsExhausted(
      config,
      "https://example.com/buy",
      shortKey,
    );

    // Short keys are returned as-is per maskKey logic
    expect(result.key!.id).toBe(shortKey);
  });
});

describe("formatPrice via paymentRequired output", () => {
  it("formats USD with dollar sign", () => {
    const config = makeConfig({ price: 1299, currency: "usd" });
    const result = paymentRequired(config, "https://example.com/buy");

    expect(result.payment.pricing.formatted).toContain("$12.99");
  });

  it("formats non-USD with uppercase currency code", () => {
    const config = makeConfig({ price: 2500, currency: "gbp" });
    const result = paymentRequired(config, "https://example.com/buy");

    expect(result.payment.pricing.formatted).toContain("25.00 GBP");
  });

  it("handles small amounts", () => {
    const config = makeConfig({ price: 1, currency: "usd" });
    const result = paymentRequired(config, "https://example.com/buy");

    expect(result.payment.pricing.formatted).toContain("$0.01");
  });
});

describe("crypto info in 402 responses", () => {
  const cryptoConfig = {
    address: "0x" + "a".repeat(40),
    pricePerCallUsd: 0.005,
    amountSmallestUnit: "5000",
    networks: ["eip155:8453"],
    facilitatorUrl: "https://gate.test/facilitator",
    mppSecret: "test-secret",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    assetDecimals: 6,
  };

  it("paymentRequired includes crypto when cryptoConfig provided", () => {
    const config = makeConfig();
    const result = paymentRequired(
      config,
      "https://example.com/__gate/buy",
      cryptoConfig,
    );

    expect(result.crypto).toBeDefined();
    expect(result.crypto!.protocols).toEqual(["x402", "mpp"]);
    expect(result.crypto!.address).toBe("0x" + "a".repeat(40));
    expect(result.crypto!.network).toBe("eip155:8453");
    expect(result.crypto!.asset).toBe("USDC");
    expect(result.crypto!.amount).toBe("5000");
    expect(result.crypto!.amountFormatted).toContain("$");
  });

  it("paymentRequired omits crypto when cryptoConfig not provided", () => {
    const config = makeConfig();
    const result = paymentRequired(config, "https://example.com/__gate/buy");

    expect(result.crypto).toBeUndefined();
  });

  it("creditsExhausted includes crypto when cryptoConfig provided", () => {
    const config = makeConfig();
    const apiKey = "gate_test_" + "a".repeat(32);
    const result = creditsExhausted(
      config,
      "https://example.com/__gate/buy",
      apiKey,
      cryptoConfig,
    );

    expect(result.crypto).toBeDefined();
    expect(result.crypto!.protocols).toEqual(["x402", "mpp"]);
    // Also still has key info
    expect(result.key).toBeDefined();
  });

  it("creditsExhausted omits crypto when cryptoConfig not provided", () => {
    const config = makeConfig();
    const result = creditsExhausted(
      config,
      "https://example.com/__gate/buy",
      "gate_test_" + "a".repeat(32),
    );

    expect(result.crypto).toBeUndefined();
  });
});

describe("GateConfigError", () => {
  it("prefixes message with [gate]", () => {
    const error = new GateConfigError("bad config");
    expect(error.message).toBe("[gate] bad config");
    expect(error.name).toBe("GateConfigError");
  });

  it("is an instance of Error", () => {
    const error = new GateConfigError("test");
    expect(error).toBeInstanceOf(Error);
  });
});
