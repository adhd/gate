import { beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { handleGatedRequest } from "../src/core.js";
import { generateKey } from "../src/keys.js";
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

describe("gate core flow", () => {
  let config: ResolvedConfig;

  beforeEach(() => {
    process.env.GATE_MODE = "test";
    config = resolveConfig({ credits: { amount: 1000, price: 500 } });
  });

  it("returns payment_required for API clients without a key", async () => {
    const result = await handleGatedRequest(apiCtx(), config);

    expect(result.action).toBe("payment_required");
    if (result.action !== "payment_required") return;
    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_required");
    expect(result.body.payment.purchase_url).toContain("gate.test/buy");
  });

  it("passes and decrements credits for a valid key", async () => {
    const key = generateKey("test");
    await config.store.set(key, makeRecord(key, 5));

    const ctx = apiCtx();
    ctx.apiKey = key;
    const result = await handleGatedRequest(ctx, config);

    expect(result.action).toBe("pass");
    if (result.action !== "pass") return;
    expect(result.keyRecord.credits).toBe(4);
  });

  it("returns 401 for invalid key", async () => {
    const ctx = apiCtx();
    ctx.apiKey = "gate_test_" + "0".repeat(32);
    const result = await handleGatedRequest(ctx, config);

    expect(result.action).toBe("error");
    if (result.action !== "error") return;
    expect(result.status).toBe(401);
  });

  it("returns credits_exhausted when key has zero credits", async () => {
    const key = generateKey("test");
    await config.store.set(key, makeRecord(key, 0));

    const ctx = apiCtx();
    ctx.apiKey = key;
    const result = await handleGatedRequest(ctx, config);

    expect(result.action).toBe("payment_required");
    if (result.action !== "payment_required") return;
    expect(result.body.error).toBe("credits_exhausted");
  });

  it("fails open when store throws", async () => {
    const failStore = {
      get: () => Promise.reject(new Error("store down")),
      set: () => Promise.reject(new Error("store down")),
      decrement: () => Promise.reject(new Error("store down")),
      delete: () => Promise.reject(new Error("store down")),
    };
    const failConfig = {
      ...config,
      store: failStore,
      failMode: "open" as const,
    };

    const ctx = apiCtx();
    ctx.apiKey = "gate_test_" + "a".repeat(32);
    const result = await handleGatedRequest(ctx, failConfig);

    expect(result.action).toBe("fail_open");
  });

  it("returns 503 when store throws in closed mode", async () => {
    const failStore = {
      get: () => Promise.reject(new Error("store down")),
      set: () => Promise.reject(new Error("store down")),
      decrement: () => Promise.reject(new Error("store down")),
      delete: () => Promise.reject(new Error("store down")),
    };
    const failConfig = {
      ...config,
      store: failStore,
      failMode: "closed" as const,
    };

    const ctx = apiCtx();
    ctx.apiKey = "gate_test_" + "a".repeat(32);
    const result = await handleGatedRequest(ctx, failConfig);

    expect(result.action).toBe("error");
    if (result.action !== "error") return;
    expect(result.status).toBe(503);
  });

  it("supports custom credit cost per route", async () => {
    const key = generateKey("test");
    await config.store.set(key, makeRecord(key, 10));

    const ctx = apiCtx();
    ctx.apiKey = key;
    const result = await handleGatedRequest(ctx, config, { cost: 5 });

    expect(result.action).toBe("pass");
    if (result.action !== "pass") return;
    expect(result.keyRecord.credits).toBe(5);
  });
});
