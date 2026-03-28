import { beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { handleGatedRequest } from "../src/core.js";
import { generateKey } from "../src/keys.js";
import type { KeyRecord } from "../src/types.js";

describe("gate core flow", () => {
  beforeEach(() => {
    process.env.GATE_MODE = "test";
  });

  it("returns payment_required for API clients without a key", async () => {
    const config = resolveConfig({
      credits: { amount: 1000, price: 500, currency: "usd" },
    });

    const result = await handleGatedRequest(
      {
        apiKey: null,
        clientType: "api",
        method: "GET",
        url: "https://api.example.com/v1/data",
        headers: {
          host: "api.example.com",
          "x-forwarded-proto": "https",
          accept: "application/json",
        },
      },
      config,
    );

    expect(result.action).toBe("payment_required");
    if (result.action !== "payment_required") return;
    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_required");
    expect(result.body.checkout_url).toContain("https://gate.test/checkout/");
  });

  it("passes and decrements credits for a valid key", async () => {
    const config = resolveConfig({
      credits: { amount: 10, price: 500, currency: "usd" },
    });

    const key = generateKey("test");
    const record: KeyRecord = {
      key,
      credits: 2,
      stripeConnectId: null,
      stripeCustomerId: null,
      stripeSessionId: "cs_test_123",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    await config.store.set(key, record);

    const result = await handleGatedRequest(
      {
        apiKey: key,
        clientType: "api",
        method: "GET",
        url: "https://api.example.com/v1/data",
        headers: {
          host: "api.example.com",
          "x-forwarded-proto": "https",
          authorization: `Bearer ${key}`,
        },
      },
      config,
    );

    expect(result.action).toBe("pass");
    if (result.action !== "pass") return;
    expect(result.keyRecord.credits).toBe(1);
  });
});
