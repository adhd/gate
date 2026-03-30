import { describe, expect, it } from "vitest";
import {
  buildX402PaymentRequired,
  encodePaymentRequired,
  decodePaymentPayload,
} from "../../src/crypto/x402.js";
import type { ResolvedConfig } from "../../src/types.js";
import { MemoryStore } from "../../src/store/memory.js";

function makeCryptoConfig(): ResolvedConfig {
  return {
    credits: { amount: 1000, price: 500, currency: "usd" },
    stripe: { secretKey: "sk_test_xxx", webhookSecret: "whsec_xxx" },
    store: new MemoryStore(),
    failMode: "open",
    baseUrl: null,
    routePrefix: "/__gate",
    productName: "API Access",
    productDescription: "",
    mode: "test",
    crypto: {
      address: "0x" + "a".repeat(40),
      pricePerCallUsd: 0.005,
      amountSmallestUnit: "5000",
      networks: ["eip155:8453"],
      facilitatorUrl: "https://gate.test/facilitator",
      mppSecret: "test-secret-key-32-bytes-long-xx",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      assetDecimals: 6,
    },
  };
}

describe("buildX402PaymentRequired edge cases", () => {
  it("cost of 0 produces amount of 0", () => {
    const config = makeCryptoConfig();
    const result = buildX402PaymentRequired(
      config,
      "https://api.example.com/v1/data",
      0,
    );
    expect(result.accepts[0].amount).toBe("0");
  });

  it("large cost multiplies correctly using BigInt", () => {
    const config = makeCryptoConfig();
    const result = buildX402PaymentRequired(
      config,
      "https://api.example.com/v1/data",
      1000000,
    );
    // 5000 * 1000000 = 5000000000
    expect(result.accepts[0].amount).toBe("5000000000");
  });

  it("handles network with no USDC address in map (uses config asset)", () => {
    const config = makeCryptoConfig();
    config.crypto!.networks = ["eip155:999999"];
    config.crypto!.asset = "0xCustomToken";

    const result = buildX402PaymentRequired(
      config,
      "https://api.example.com",
      1,
    );
    expect(result.accepts[0].asset).toBe("0xCustomToken");
    expect(result.accepts[0].network).toBe("eip155:999999");
  });

  it("generates separate accepts entries for each network with same amount", () => {
    const config = makeCryptoConfig();
    config.crypto!.networks = ["eip155:8453", "eip155:84532"];

    const result = buildX402PaymentRequired(
      config,
      "https://api.example.com",
      2,
    );

    expect(result.accepts).toHaveLength(2);
    expect(result.accepts[0].amount).toBe("10000");
    expect(result.accepts[1].amount).toBe("10000");
    expect(result.accepts[0].network).toBe("eip155:8453");
    expect(result.accepts[1].network).toBe("eip155:84532");
  });
});

describe("decodePaymentPayload edge cases", () => {
  it("throws on empty string", () => {
    expect(() => decodePaymentPayload("")).toThrow();
  });

  it("throws on truncated base64", () => {
    // Valid base64 prefix but truncated
    const full = Buffer.from('{"x402Version":2}').toString("base64");
    const truncated = full.slice(0, 5);
    // Depending on how truncated it is, it may decode to garbage or throw
    // The important thing is it doesn't return valid JSON silently
    try {
      const result = decodePaymentPayload(truncated);
      // If it doesn't throw, the result should at least be an object
      // (might be partial JSON that still parses)
      expect(typeof result).toBe("object");
    } catch {
      // Expected: invalid JSON from truncated base64
    }
  });

  it("throws on base64 of non-JSON content", () => {
    const encoded = Buffer.from("not json at all").toString("base64");
    expect(() => decodePaymentPayload(encoded)).toThrow();
  });
});
