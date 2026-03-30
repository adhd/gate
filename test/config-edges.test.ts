import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import { GateConfigError } from "../src/errors.js";

describe("resolveConfig edge cases", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and set baseline env
    for (const key of [
      "GATE_MODE",
      "NODE_ENV",
      "GATE_ALLOW_TEST_IN_PRODUCTION",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "GATE_MPP_SECRET",
    ]) {
      savedEnv[key] = process.env[key];
    }
    process.env.GATE_MODE = "test";
    delete process.env.NODE_ENV;
    delete process.env.GATE_ALLOW_TEST_IN_PRODUCTION;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.GATE_MPP_SECRET;
  });

  afterEach(() => {
    // Restore all env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  // --- credits.amount edge cases ---
  it("throws for NaN credits.amount", () => {
    expect(() =>
      resolveConfig({ credits: { amount: NaN, price: 500 } }),
    ).toThrow(GateConfigError);
  });

  it("throws for Infinity credits.amount", () => {
    expect(() =>
      resolveConfig({ credits: { amount: Infinity, price: 500 } }),
    ).toThrow(GateConfigError);
  });

  it("throws for negative Infinity credits.amount", () => {
    expect(() =>
      resolveConfig({ credits: { amount: -Infinity, price: 500 } }),
    ).toThrow(GateConfigError);
  });

  // --- credits.price edge cases ---
  it("throws for NaN credits.price", () => {
    expect(() =>
      resolveConfig({ credits: { amount: 100, price: NaN } }),
    ).toThrow(GateConfigError);
  });

  it("throws for Infinity credits.price", () => {
    expect(() =>
      resolveConfig({ credits: { amount: 100, price: Infinity } }),
    ).toThrow(GateConfigError);
  });

  // --- crypto.pricePerCall edge cases ---
  it("throws for NaN pricePerCall", () => {
    expect(() =>
      resolveConfig({
        credits: { amount: 100, price: 500 },
        crypto: { address: "0x" + "a".repeat(40), pricePerCall: NaN },
      }),
    ).toThrow(/pricePerCall/i);
  });

  it("throws for Infinity pricePerCall", () => {
    expect(() =>
      resolveConfig({
        credits: { amount: 100, price: 500 },
        crypto: { address: "0x" + "a".repeat(40), pricePerCall: Infinity },
      }),
    ).toThrow(/pricePerCall/i);
  });

  it("throws for negative pricePerCall", () => {
    expect(() =>
      resolveConfig({
        credits: { amount: 100, price: 500 },
        crypto: { address: "0x" + "a".repeat(40), pricePerCall: -0.005 },
      }),
    ).toThrow(/pricePerCall/i);
  });

  // --- crypto.address edge cases ---
  it("throws for address that is 42 chars but does not start with 0x", () => {
    expect(() =>
      resolveConfig({
        credits: { amount: 100, price: 500 },
        crypto: { address: "xx" + "a".repeat(40), pricePerCall: 0.005 },
      }),
    ).toThrow(/address/i);
  });

  it("throws for address that starts with 0x but is 41 chars", () => {
    expect(() =>
      resolveConfig({
        credits: { amount: 100, price: 500 },
        crypto: { address: "0x" + "a".repeat(39), pricePerCall: 0.005 },
      }),
    ).toThrow(/address/i);
  });

  it("throws for address that starts with 0x but is 43 chars", () => {
    expect(() =>
      resolveConfig({
        credits: { amount: 100, price: 500 },
        crypto: { address: "0x" + "a".repeat(41), pricePerCall: 0.005 },
      }),
    ).toThrow(/address/i);
  });

  // --- GATE_MODE=test in production guard ---
  it("throws when GATE_MODE=test and NODE_ENV=production", () => {
    process.env.GATE_MODE = "test";
    process.env.NODE_ENV = "production";

    expect(() =>
      resolveConfig({ credits: { amount: 100, price: 500 } }),
    ).toThrow(/GATE_MODE=test cannot be used/);
  });

  it("allows GATE_MODE=test in production when override flag is set", () => {
    process.env.GATE_MODE = "test";
    process.env.NODE_ENV = "production";
    process.env.GATE_ALLOW_TEST_IN_PRODUCTION = "true";

    expect(() =>
      resolveConfig({ credits: { amount: 100, price: 500 } }),
    ).not.toThrow();
  });

  // --- mppSecret required in live mode ---
  it("throws when crypto.mppSecret is missing in live mode", () => {
    process.env.GATE_MODE = "live";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";

    expect(() =>
      resolveConfig({
        credits: { amount: 100, price: 500 },
        baseUrl: "https://api.example.com",
        crypto: { address: "0x" + "a".repeat(40), pricePerCall: 0.005 },
      }),
    ).toThrow(/mppSecret/i);
  });

  it("reads mppSecret from GATE_MPP_SECRET env var", () => {
    process.env.GATE_MPP_SECRET = "env-secret-that-is-long-enough-32";
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: { address: "0x" + "a".repeat(40), pricePerCall: 0.005 },
    });

    expect(config.crypto!.mppSecret).toBe("env-secret-that-is-long-enough-32");
  });

  // --- Network mapping ---
  it("passes through CAIP-2 formatted network strings unchanged", () => {
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
        networks: ["eip155:8453"],
      },
    });
    expect(config.crypto!.networks).toEqual(["eip155:8453"]);
  });

  it("passes through unknown network names unchanged", () => {
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
        networks: ["polygon"],
      },
    });
    // "polygon" is not in NETWORK_MAP and doesn't contain ":", so it stays as-is
    expect(config.crypto!.networks).toEqual(["polygon"]);
  });

  // --- Default values ---
  it("applies all defaults correctly", () => {
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
    });

    expect(config.credits.currency).toBe("usd");
    expect(config.failMode).toBe("open");
    expect(config.routePrefix).toBe("/__gate");
    expect(config.productName).toBe("API Access");
    expect(config.productDescription).toBe("");
    expect(config.baseUrl).toBeNull();
  });

  it("respects custom failMode", () => {
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      failMode: "closed",
    });
    expect(config.failMode).toBe("closed");
  });

  it("respects custom routePrefix", () => {
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      routePrefix: "/billing",
    });
    expect(config.routePrefix).toBe("/billing");
  });

  it("respects custom productName and productDescription", () => {
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      productName: "Premium API",
      productDescription: "Full access to the premium API",
    });
    expect(config.productName).toBe("Premium API");
    expect(config.productDescription).toBe("Full access to the premium API");
  });

  it("uses live facilitator URL in live mode", () => {
    process.env.GATE_MODE = "live";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";

    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      baseUrl: "https://api.example.com",
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
        mppSecret: "live-secret-key-32-bytes-long-xx",
      },
    });
    expect(config.crypto!.facilitatorUrl).toBe("https://x402.org/facilitator");
  });

  it("uses custom facilitator URL in live mode when provided", () => {
    process.env.GATE_MODE = "live";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";

    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      baseUrl: "https://api.example.com",
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
        mppSecret: "live-secret-key-32-bytes-long-xx",
        facilitatorUrl: "https://custom-facilitator.example.com",
      },
    });
    expect(config.crypto!.facilitatorUrl).toBe(
      "https://custom-facilitator.example.com",
    );
  });

  // --- USDC asset resolution ---
  it("resolves USDC asset address from first network", () => {
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
        networks: ["base"],
      },
    });
    expect(config.crypto!.asset).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
  });

  it("uses custom asset address when provided", () => {
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
        asset: "0xCustomAsset",
      },
    });
    expect(config.crypto!.asset).toBe("0xCustomAsset");
  });

  // --- Floating point conversion ---
  it("handles fractional pricePerCall conversion to smallest unit", () => {
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.000001,
      },
    });
    // 0.000001 * 10^6 = 1
    expect(config.crypto!.amountSmallestUnit).toBe("1");
  });

  it("handles very small pricePerCall that rounds to 0", () => {
    const config = resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.0000001,
      },
    });
    // 0.0000001 * 10^6 = 0.1, Math.round = 0
    expect(config.crypto!.amountSmallestUnit).toBe("0");
  });
});
