import { beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { GateConfigError } from "../src/errors.js";

describe("resolveConfig", () => {
  beforeEach(() => {
    process.env.GATE_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
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

  it("throws in live mode without Stripe keys", () => {
    process.env.GATE_MODE = "live";

    expect(() =>
      resolveConfig({ credits: { amount: 100, price: 500 } }),
    ).toThrow(/Stripe secret key required/);
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
});
