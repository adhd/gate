import { beforeEach, describe, expect, it } from "vitest";
import { handleGatedRequest } from "../src/core.js";
import { generateKey } from "../src/keys.js";
import { MemoryStore } from "../src/store/memory.js";
import type { KeyRecord, ResolvedConfig } from "../src/types.js";

function makeRecord(key: string, credits: number): KeyRecord {
  return {
    key,
    credits,
    stripeCustomerId: null,
    stripeSessionId: "cs_test_123",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
}

function apiCtx(headers: Record<string, string> = {}) {
  return {
    apiKey: null as string | null,
    clientType: "api" as const,
    method: "GET",
    url: "https://api.example.com/v1/data",
    headers: {
      host: "api.example.com",
      "x-forwarded-proto": "https",
      accept: "application/json",
      ...headers,
    },
  };
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    credits: { amount: 1000, price: 500, currency: "usd" },
    stripe: { secretKey: "", webhookSecret: "" },
    store: new MemoryStore(),
    failMode: "open",
    baseUrl: null,
    routePrefix: "/__gate",
    productName: "API Access",
    productDescription: "",
    mode: "test",
    crypto: null,
    ...overrides,
  };
}

describe("core edge cases", () => {
  it("cost of 0 passes without decrementing credits", async () => {
    const config = makeConfig();
    const key = generateKey("test");
    await config.store.set(key, makeRecord(key, 5));

    const ctx = apiCtx();
    ctx.apiKey = key;
    const result = await handleGatedRequest(ctx, config, { cost: 0 });

    // cost 0 means decrement(key, 0) -- MemoryStore: 5 >= 0 so it passes
    expect(result.action).toBe("pass");
    if (result.action !== "pass") return;
    expect(result.remaining).toBe(5);
  });

  it("handles cost greater than available credits (returns exhausted)", async () => {
    const config = makeConfig();
    const key = generateKey("test");
    await config.store.set(key, makeRecord(key, 3));

    const ctx = apiCtx();
    ctx.apiKey = key;
    const result = await handleGatedRequest(ctx, config, { cost: 5 });

    expect(result.action).toBe("payment_required");
    if (result.action !== "payment_required") return;
    expect(result.body.error).toBe("credits_exhausted");
  });

  it("classifyClient is used when ctx.clientType is null", async () => {
    const config = makeConfig();
    const ctx = {
      apiKey: null,
      clientType: null,
      method: "GET",
      url: "https://api.example.com/v1/data",
      headers: {
        host: "api.example.com",
        accept: "text/html",
        "user-agent": "Mozilla/5.0 Chrome/120",
      },
    };

    const result = await handleGatedRequest(ctx, config);
    // classifyClient should detect browser from headers
    expect(result.action).toBe("redirect");
  });

  it("classifyClient returns api when ctx.clientType is null and headers are API-like", async () => {
    const config = makeConfig();
    const ctx = {
      apiKey: null,
      clientType: null,
      method: "GET",
      url: "https://api.example.com/v1/data",
      headers: {
        host: "api.example.com",
        accept: "application/json",
        "user-agent": "python-requests/2.28.0",
      },
    };

    const result = await handleGatedRequest(ctx, config);
    expect(result.action).toBe("payment_required");
  });

  it("buildPurchaseUrl uses baseUrl when available in non-test mode", async () => {
    const config = makeConfig({
      mode: "live" as const,
      baseUrl: "https://myapi.example.com",
      stripe: { secretKey: "sk_test_123", webhookSecret: "whsec_123" },
    });

    const ctx = apiCtx();
    const result = await handleGatedRequest(ctx, config);

    if (result.action !== "payment_required") {
      expect.unreachable("Expected payment_required");
    }
    expect(result.body.payment.purchase_url).toBe(
      "https://myapi.example.com/__gate/buy",
    );
  });

  it("buildPurchaseUrl falls back to x-forwarded-proto + host when no baseUrl in live mode", async () => {
    const config = makeConfig({
      mode: "live" as const,
      baseUrl: null,
      stripe: { secretKey: "sk_test_123", webhookSecret: "whsec_123" },
    });

    const ctx = apiCtx({
      host: "custom-host.example.com",
      "x-forwarded-proto": "https",
    });
    const result = await handleGatedRequest(ctx, config);

    if (result.action !== "payment_required") {
      expect.unreachable("Expected payment_required");
    }
    expect(result.body.payment.purchase_url).toBe(
      "https://custom-host.example.com/__gate/buy",
    );
  });

  it("buildPurchaseUrl uses custom routePrefix", async () => {
    const config = makeConfig({
      mode: "live" as const,
      baseUrl: "https://api.example.com",
      routePrefix: "/billing",
      stripe: { secretKey: "sk_test_123", webhookSecret: "whsec_123" },
    });

    const ctx = apiCtx();
    const result = await handleGatedRequest(ctx, config);

    if (result.action !== "payment_required") {
      expect.unreachable("Expected payment_required");
    }
    expect(result.body.payment.purchase_url).toBe(
      "https://api.example.com/billing/buy",
    );
  });

  it("malformed x402 payment header falls through to normal flow", async () => {
    const config = makeConfig({
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCallUsd: 0.005,
        amountSmallestUnit: "5000",
        networks: ["eip155:8453"],
        facilitatorUrl: "https://gate.test/facilitator",
        mppSecret: "test-secret-key-that-is-at-least-32-bytes",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        assetDecimals: 6,
      },
    });

    // Send a payment-signature header that decodes to valid base64 but invalid JSON
    const badBase64 = Buffer.from("this is not json").toString("base64");
    const ctx = apiCtx({ "payment-signature": badBase64 });
    const result = await handleGatedRequest(ctx, config);

    // extractX402Payment returns null for malformed, so we fall through to key check
    // No key provided, so we get payment_required
    expect(result.action).toBe("payment_required");
  });

  it("x402 payment with empty accepted object still runs verification", async () => {
    const config = makeConfig({
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCallUsd: 0.005,
        amountSmallestUnit: "5000",
        networks: ["eip155:8453"],
        facilitatorUrl: "https://gate.test/facilitator",
        mppSecret: "test-secret-key-that-is-at-least-32-bytes",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        assetDecimals: 6,
      },
    });

    // Payload that parses but has no network on accepted
    const payload = {
      x402Version: 2,
      accepted: { scheme: "exact" },
      payload: { payer: "0xSomeone" },
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");

    const ctx = apiCtx({ "payment-signature": encoded });
    const result = await handleGatedRequest(ctx, config);

    // In test mode, verifyX402Payment auto-verifies, so this passes
    expect(result.action).toBe("pass_crypto");
  });

  it("malformed MPP credential returns error 402", async () => {
    const config = makeConfig({
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCallUsd: 0.005,
        amountSmallestUnit: "5000",
        networks: ["eip155:8453"],
        facilitatorUrl: "https://gate.test/facilitator",
        mppSecret: "test-secret-key-that-is-at-least-32-bytes",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        assetDecimals: 6,
      },
    });

    // Send a Payment auth header with garbage
    const ctx = apiCtx({ authorization: "Payment not-valid-json" });
    const result = await handleGatedRequest(ctx, config);

    expect(result.action).toBe("error");
    if (result.action !== "error") return;
    expect(result.status).toBe(402);
    expect(result.message).toContain("Malformed");
  });
});
