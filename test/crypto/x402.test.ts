import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildX402PaymentRequired,
  encodePaymentRequired,
  decodePaymentPayload,
  hasX402Payment,
  extractX402Payment,
  verifyX402Payment,
  settleX402Payment,
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

describe("buildX402PaymentRequired", () => {
  it("returns correct structure with all fields", () => {
    const config = makeCryptoConfig();
    const result = buildX402PaymentRequired(
      config,
      "https://api.example.com/v1/data",
      1,
    );

    expect(result.x402Version).toBe(2);
    expect(result.resource.url).toBe("https://api.example.com/v1/data");
    expect(result.resource.mimeType).toBe("application/json");
    expect(result.accepts).toHaveLength(1);
    expect(result.accepts[0].scheme).toBe("exact");
    expect(result.accepts[0].network).toBe("eip155:8453");
    expect(result.accepts[0].asset).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
    expect(result.accepts[0].amount).toBe("5000");
    expect(result.accepts[0].payTo).toBe("0x" + "a".repeat(40));
    expect(result.accepts[0].maxTimeoutSeconds).toBe(60);
    expect(result.accepts[0].extra).toEqual({
      name: "USD Coin",
      version: "2",
    });
  });

  it("multiplies amount by cost", () => {
    const config = makeCryptoConfig();
    const result = buildX402PaymentRequired(
      config,
      "https://api.example.com/v1/data",
      5,
    );

    // 5000 * 5 = 25000
    expect(result.accepts[0].amount).toBe("25000");
  });

  it("generates accepts entry for each network", () => {
    const config = makeCryptoConfig();
    config.crypto!.networks = ["eip155:8453", "eip155:84532"];

    const result = buildX402PaymentRequired(
      config,
      "https://api.example.com/v1/data",
      1,
    );

    expect(result.accepts).toHaveLength(2);
    expect(result.accepts[0].network).toBe("eip155:8453");
    expect(result.accepts[1].network).toBe("eip155:84532");
  });
});

describe("encodePaymentRequired / decodePaymentPayload round-trip", () => {
  it("encodes and decodes correctly", () => {
    const config = makeCryptoConfig();
    const pr = buildX402PaymentRequired(
      config,
      "https://api.example.com/v1/data",
      1,
    );

    const encoded = encodePaymentRequired(pr);
    expect(typeof encoded).toBe("string");

    // Decode to verify it round-trips
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf-8"),
    );
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe("https://api.example.com/v1/data");
    expect(decoded.accepts[0].amount).toBe("5000");
  });

  it("decodePaymentPayload parses a base64 payment payload", () => {
    const payload = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "5000",
        payTo: "0x" + "a".repeat(40),
        maxTimeoutSeconds: 60,
        extra: {},
      },
      payload: { hash: "0xabc123" },
    };

    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    const decoded = decodePaymentPayload(encoded);

    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.network).toBe("eip155:8453");
    expect(decoded.payload.hash).toBe("0xabc123");
  });
});

describe("hasX402Payment", () => {
  it("returns true for payment-signature header", () => {
    expect(hasX402Payment({ "payment-signature": "abc123" })).toBe(true);
  });

  it("returns true for x-payment header", () => {
    expect(hasX402Payment({ "x-payment": "abc123" })).toBe(true);
  });

  it("returns false when neither header present", () => {
    expect(hasX402Payment({ authorization: "Bearer token123" })).toBe(false);
  });

  it("returns false for empty headers", () => {
    expect(hasX402Payment({})).toBe(false);
  });
});

describe("extractX402Payment", () => {
  it("extracts payment from payment-signature header", () => {
    const payload = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "5000",
        payTo: "0x" + "a".repeat(40),
        maxTimeoutSeconds: 60,
        extra: {},
      },
      payload: { fromAddress: "0xPayer123" },
    };

    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    const result = extractX402Payment({ "payment-signature": encoded });

    expect(result).not.toBeNull();
    expect(result!.x402Version).toBe(2);
    expect(result!.payload.fromAddress).toBe("0xPayer123");
  });

  it("extracts payment from x-payment header", () => {
    const payload = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "5000",
        payTo: "0x" + "a".repeat(40),
        maxTimeoutSeconds: 60,
        extra: {},
      },
      payload: {},
    };

    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    const result = extractX402Payment({ "x-payment": encoded });

    expect(result).not.toBeNull();
    expect(result!.x402Version).toBe(2);
  });

  it("returns null for missing headers", () => {
    expect(extractX402Payment({})).toBeNull();
  });

  it("returns null for malformed base64", () => {
    expect(
      extractX402Payment({ "payment-signature": "not-valid-json!!!" }),
    ).toBeNull();
  });

  it("returns null for valid base64 but invalid JSON", () => {
    const badBase64 = Buffer.from("this is not json").toString("base64");
    expect(extractX402Payment({ "payment-signature": badBase64 })).toBeNull();
  });
});

describe("verifyX402Payment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mockPayload = {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "5000",
      payTo: "0x" + "a".repeat(40),
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: { fromAddress: "0xPayer123" },
  };

  const mockRequirements = mockPayload.accepted;

  it("auto-verifies in test mode", async () => {
    const result = await verifyX402Payment(
      "https://gate.test/facilitator",
      mockPayload,
      mockRequirements,
      "test",
    );

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("0xPayer123");
  });

  it("auto-verifies with default payer when no payer in payload", async () => {
    const payloadNoPayer = { ...mockPayload, payload: {} };
    const result = await verifyX402Payment(
      "https://gate.test/facilitator",
      payloadNoPayer,
      mockRequirements,
      "test",
    );

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("0xTestPayer");
  });

  it("calls facilitator /verify and returns success", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ isValid: true, payer: "0xRealPayer" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await verifyX402Payment(
      "https://x402.org/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://x402.org/facilitator/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: mockPayload,
          paymentRequirements: mockRequirements,
        }),
      },
    );
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("0xRealPayer");
  });

  it("returns invalid when facilitator returns non-OK status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await verifyX402Payment(
      "https://x402.org/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("400");
  });

  it("returns invalid when fetch throws (network error)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network timeout"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await verifyX402Payment(
      "https://x402.org/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("Network timeout");
  });
});

describe("settleX402Payment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mockPayload = {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "5000",
      payTo: "0x" + "a".repeat(40),
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: { fromAddress: "0xPayer123" },
  };

  const mockRequirements = mockPayload.accepted;

  it("auto-settles in test mode", async () => {
    const result = await settleX402Payment(
      "https://gate.test/facilitator",
      mockPayload,
      mockRequirements,
      "test",
    );

    expect(result.success).toBe(true);
    expect(result.transaction).toContain("0xTestTxHash_");
    expect(result.network).toBe("eip155:8453");
    expect(result.payer).toBe("0xPayer123");
  });

  it("calls facilitator /settle and returns success", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          transaction: "0xRealTx",
          network: "eip155:8453",
          payer: "0xRealPayer",
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await settleX402Payment(
      "https://x402.org/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://x402.org/facilitator/settle",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: mockPayload,
          paymentRequirements: mockRequirements,
        }),
      },
    );
    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0xRealTx");
  });

  it("returns failure when facilitator returns non-OK status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await settleX402Payment(
      "https://x402.org/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(result.success).toBe(false);
    expect(result.transaction).toBe("");
    expect(result.errorReason).toContain("500");
  });

  it("returns failure when fetch throws (network error)", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await settleX402Payment(
      "https://x402.org/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toContain("Connection refused");
  });
});
