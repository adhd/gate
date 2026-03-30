/**
 * Stripe tests use test-mode stubs only (no real Stripe API calls).
 * Live Stripe paths (real checkout sessions, webhook signature verification,
 * customer creation) require integration test infrastructure with a Stripe
 * test-mode API key and are not covered here.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  createCheckoutSession,
  handleCheckoutSuccess,
  handleWebhook,
} from "../src/stripe.js";
import { MemoryStore } from "../src/store/memory.js";
import { generateKey } from "../src/keys.js";
import type { ResolvedConfig, KeyRecord } from "../src/types.js";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    credits: { amount: 100, price: 500, currency: "usd" },
    stripe: { secretKey: "sk_test_xxx", webhookSecret: "whsec_xxx" },
    store: new MemoryStore(),
    failMode: "open",
    baseUrl: "https://api.example.com",
    routePrefix: "/__gate",
    productName: "API Access",
    productDescription: "Access to the API",
    mode: "test",
    crypto: null,
    ...overrides,
  };
}

describe("createCheckoutSession", () => {
  it("returns a fake URL in test mode", async () => {
    const config = makeConfig({ mode: "test" });
    const url = await createCheckoutSession(config);

    expect(url).toMatch(/^https:\/\/gate\.test\/checkout\/test_session_\d+$/);
  });

  it("returns a different URL on each call in test mode (timestamp-based)", async () => {
    const config = makeConfig({ mode: "test" });
    const url1 = await createCheckoutSession(config);
    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 5));
    const url2 = await createCheckoutSession(config);

    expect(url1).not.toBe(url2);
  });

  it("passes returnTo parameter but ignores it in test mode", async () => {
    const config = makeConfig({ mode: "test" });
    const url = await createCheckoutSession(config, "https://myapp.com/back");

    // Test mode ignores returnTo entirely
    expect(url).toMatch(/^https:\/\/gate\.test\/checkout\//);
  });
});

describe("handleCheckoutSuccess", () => {
  it("creates a key and record in test mode", async () => {
    const store = new MemoryStore();
    const config = makeConfig({ store });

    const result = await handleCheckoutSuccess("cs_test_abc", config, store);

    expect(result).not.toBeNull();
    expect(result!.key).toMatch(/^gate_test_/);
    expect(result!.record.credits).toBe(100);
    expect(result!.record.stripeCustomerId).toBeNull();
    expect(result!.record.stripeSessionId).toBe("cs_test_abc");
  });

  it("is idempotent: same session returns same key", async () => {
    const store = new MemoryStore();
    const config = makeConfig({ store });

    const result1 = await handleCheckoutSuccess("cs_test_idem", config, store);
    const result2 = await handleCheckoutSuccess("cs_test_idem", config, store);

    expect(result1!.key).toBe(result2!.key);
    expect(result1!.record.credits).toBe(result2!.record.credits);
  });

  it("stores session mapping for idempotency", async () => {
    const store = new MemoryStore();
    const config = makeConfig({ store });

    await handleCheckoutSuccess("cs_test_session_map", config, store);

    const sessionRecord = await store.get("session:cs_test_session_map");
    expect(sessionRecord).not.toBeNull();
    expect(sessionRecord!.key).toMatch(/^gate_test_/);
  });

  it("stores the key record separately from session record", async () => {
    const store = new MemoryStore();
    const config = makeConfig({ store });

    const result = await handleCheckoutSuccess("cs_test_sep", config, store);
    const keyRecord = await store.get(result!.key);

    expect(keyRecord).not.toBeNull();
    expect(keyRecord!.credits).toBe(100);
    expect(keyRecord!.stripeSessionId).toBe("cs_test_sep");
  });

  it("uses config credits.amount for test mode (not metadata)", async () => {
    const store = new MemoryStore();
    const config = makeConfig({
      store,
      credits: { amount: 50, price: 300, currency: "usd" },
    });

    const result = await handleCheckoutSuccess("cs_test_amt", config, store);
    expect(result!.record.credits).toBe(50);
  });

  it("sets createdAt to a valid ISO string", async () => {
    const store = new MemoryStore();
    const config = makeConfig({ store });

    const result = await handleCheckoutSuccess("cs_test_date", config, store);
    const date = new Date(result!.record.createdAt);

    expect(date.toISOString()).toBe(result!.record.createdAt);
    expect(Date.now() - date.getTime()).toBeLessThan(5000);
  });

  it("sets lastUsedAt to null on creation", async () => {
    const store = new MemoryStore();
    const config = makeConfig({ store });

    const result = await handleCheckoutSuccess("cs_test_lu", config, store);
    expect(result!.record.lastUsedAt).toBeNull();
  });
});

describe("handleWebhook", () => {
  it("returns null in test mode (webhooks are skipped)", async () => {
    const store = new MemoryStore();
    const config = makeConfig({ store, mode: "test" });

    const result = await handleWebhook("{}", "sig_test_123", config, store);

    expect(result).toBeNull();
  });
});
