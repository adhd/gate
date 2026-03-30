import { beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { GateConfigError } from "../src/errors.js";

describe("resolveConfig", () => {
  beforeEach(() => {
    process.env.GATE_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.GATE_MPP_SECRET;
  });

  it("resolves valid config with defaults", () => {
    const config = resolveConfig({
      credits: { amount: 1000, price: 500 },
    });

    expect(config.credits.amount).toBe(1000);
    expect(config.credits.price).toBe(500);
    expect(config.credits.currency).toBe("usd");
    expect(config.failMode).toBe("open");
    expect(config.productName).toBe("API Access");
    expect(config.mode).toBe("test");
  });

  it("throws on invalid credits.amount", () => {
    expect(() => resolveConfig({ credits: { amount: 0, price: 500 } })).toThrow(
      GateConfigError,
    );
    expect(() =>
      resolveConfig({ credits: { amount: -1, price: 500 } }),
    ).toThrow(GateConfigError);
  });

  it("throws on invalid credits.price", () => {
    expect(() => resolveConfig({ credits: { amount: 100, price: 0 } })).toThrow(
      GateConfigError,
    );
    expect(() =>
      resolveConfig({ credits: { amount: 100, price: -50 } }),
    ).toThrow(GateConfigError);
  });

  it("throws in live mode without Stripe keys or crypto", () => {
    process.env.GATE_MODE = "live";

    expect(() =>
      resolveConfig({ credits: { amount: 100, price: 500 } }),
    ).toThrow(/stripe or crypto/i);
  });

  it("does not throw in test mode without Stripe keys", () => {
    process.env.GATE_MODE = "test";

    expect(() =>
      resolveConfig({ credits: { amount: 100, price: 500 } }),
    ).not.toThrow();
  });

  it("reads Stripe keys from env vars", () => {
    process.env.GATE_MODE = "live";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";

    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      baseUrl: "https://api.example.com",
    });
    expect(config.stripe.secretKey).toBe("sk_test_123");
    expect(config.stripe.webhookSecret).toBe("whsec_123");
  });

  it("throws in live mode without baseUrl", () => {
    process.env.GATE_MODE = "live";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";

    expect(() =>
      resolveConfig({ credits: { amount: 100, price: 500 } }),
    ).toThrow(/baseUrl is required/);
  });

  it("prefers config values over env vars", () => {
    process.env.STRIPE_SECRET_KEY = "sk_from_env";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_from_env";

    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      stripe: {
        secretKey: "sk_from_config",
        webhookSecret: "whsec_from_config",
      },
    });
    expect(config.stripe.secretKey).toBe("sk_from_config");
    expect(config.stripe.webhookSecret).toBe("whsec_from_config");
  });

  it("sets crypto to null when not provided", () => {
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
    });
    expect(config.crypto).toBeNull();
  });

  it("accepts crypto config without stripe in live mode", () => {
    process.env.GATE_MODE = "live";
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
        mppSecret: "test-secret-key-32-bytes-long-xx",
      },
      baseUrl: "https://api.example.com",
    });
    expect(config.crypto).not.toBeNull();
    expect(config.crypto!.amountSmallestUnit).toBe("5000");
  });

  it("throws when neither stripe nor crypto in live mode", () => {
    process.env.GATE_MODE = "live";
    expect(() =>
      resolveConfig({
        credits: { amount: 100, price: 500 },
        baseUrl: "https://api.example.com",
      }),
    ).toThrow(/stripe or crypto/i);
  });

  it("validates crypto address format", () => {
    process.env.GATE_MODE = "test";
    expect(() =>
      resolveConfig({
        credits: { amount: 100, price: 500 },
        crypto: { address: "not-an-address", pricePerCall: 0.005 },
      }),
    ).toThrow(/address/i);
  });

  it("validates crypto pricePerCall is positive", () => {
    process.env.GATE_MODE = "test";
    expect(() =>
      resolveConfig({
        credits: { amount: 100, price: 500 },
        crypto: { address: "0x" + "a".repeat(40), pricePerCall: 0 },
      }),
    ).toThrow(/pricePerCall/i);
  });

  it("converts USD to smallest unit correctly", () => {
    process.env.GATE_MODE = "test";
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: { address: "0x" + "a".repeat(40), pricePerCall: 1.0 },
    });
    expect(config.crypto!.amountSmallestUnit).toBe("1000000");
  });

  it("maps network shorthands to CAIP-2", () => {
    process.env.GATE_MODE = "test";
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
        networks: ["base-sepolia"],
      },
    });
    expect(config.crypto!.networks).toEqual(["eip155:84532"]);
  });

  it("auto-generates mppSecret in test mode", () => {
    process.env.GATE_MODE = "test";
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: { address: "0x" + "a".repeat(40), pricePerCall: 0.005 },
    });
    expect(config.crypto!.mppSecret).toBeTruthy();
    expect(config.crypto!.mppSecret.length).toBeGreaterThanOrEqual(32);
  });

  it("uses test facilitator URL in test mode", () => {
    process.env.GATE_MODE = "test";
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: { address: "0x" + "a".repeat(40), pricePerCall: 0.005 },
    });
    expect(config.crypto!.facilitatorUrl).toContain("gate.test");
  });
});
