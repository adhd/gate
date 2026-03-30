import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountGate } from "../../src/adapters/hono.js";
import { generateKey } from "../../src/keys.js";
import type { KeyRecord } from "../../src/types.js";

function makeRecord(key: string, credits: number): KeyRecord {
  return {
    key,
    credits,
    stripeCustomerId: null,
    stripeSessionId: "cs_test_demo",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
}

function buildHonoApp() {
  const app = new Hono();
  const billing = mountGate({
    credits: { amount: 100, price: 500 },
  });

  app.use("/api/*", billing.middleware);
  app.get("/api/data", (c) => c.json({ ok: true }));

  const gateRoutes = new Hono();
  billing.routes(gateRoutes);
  app.route("/__gate", gateRoutes);

  return { app, billing };
}

describe("hono adapter integration", () => {
  beforeEach(() => {
    process.env.GATE_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("returns 402 for API client without key", async () => {
    const { app } = buildHonoApp();

    const res = await app.request("http://localhost/api/data", {
      headers: { accept: "application/json", "user-agent": "curl/8.0" },
    });
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error).toBe("payment_required");
    expect(body.payment.purchase_url).toContain("gate.test/buy");
    expect(res.headers.get("x-payment-protocol")).toBe("gate/v1");
  });

  it("redirects browser client without key", async () => {
    const { app } = buildHonoApp();

    const res = await app.request("http://localhost/api/data", {
      headers: {
        accept: "text/html",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("gate.test/buy");
  });

  it("passes and decrements with valid key", async () => {
    const { app, billing } = buildHonoApp();
    const key = generateKey("test");
    await billing.resolved.store.set(key, makeRecord(key, 2));

    const res = await app.request("http://localhost/api/data", {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("x-gate-credits-remaining")).toBe("1");

    const updated = await billing.resolved.store.get(key);
    expect(updated?.credits).toBe(1);
  });

  it("returns 402 credits_exhausted when key has zero credits", async () => {
    const { app, billing } = buildHonoApp();
    const key = generateKey("test");
    await billing.resolved.store.set(key, makeRecord(key, 0));

    const res = await app.request("http://localhost/api/data", {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error).toBe("credits_exhausted");
    expect(body.payment.purchase_url).toContain("gate.test/buy");
  });

  it("returns 401 for invalid key", async () => {
    const { app } = buildHonoApp();

    const res = await app.request("http://localhost/api/data", {
      headers: {
        authorization: "Bearer gate_test_" + "0".repeat(32),
        accept: "application/json",
      },
    });
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Invalid API key");
  });

  it("serves pricing endpoint", async () => {
    const { app } = buildHonoApp();

    const res = await app.request("http://localhost/__gate/pricing");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.credits).toBe(100);
    expect(body.price).toBe(500);
  });

  it("serves status endpoint with valid key", async () => {
    const { app, billing } = buildHonoApp();
    const key = generateKey("test");
    await billing.resolved.store.set(key, makeRecord(key, 42));

    const res = await app.request("http://localhost/__gate/status", {
      headers: { authorization: `Bearer ${key}` },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.credits_remaining).toBe(42);
  });

  describe("crypto headers", () => {
    function buildCryptoApp() {
      const app = new Hono();
      const billing = mountGate({
        credits: { amount: 100, price: 500 },
        crypto: {
          address: "0x" + "a".repeat(40),
          pricePerCall: 0.005,
        },
      });

      app.use("/api/*", billing.middleware);
      app.get("/api/data", (c) => c.json({ ok: true }));

      const gateRoutes = new Hono();
      billing.routes(gateRoutes);
      app.route("/__gate", gateRoutes);

      return { app, billing };
    }

    it("402 includes PAYMENT-REQUIRED header when crypto configured", async () => {
      const { app } = buildCryptoApp();

      const res = await app.request("http://localhost/api/data", {
        headers: { accept: "application/json", "user-agent": "curl/8.0" },
      });

      expect(res.status).toBe(402);
      const pr = res.headers.get("payment-required");
      expect(pr).toBeTruthy();

      // Decode and verify structure
      const decoded = JSON.parse(atob(pr!));
      expect(decoded.x402Version).toBe(2);
      expect(decoded.accepts).toBeInstanceOf(Array);
      expect(decoded.accepts[0].payTo).toBe("0x" + "a".repeat(40));
      expect(decoded.accepts[0].amount).toBe("5000");
    });

    it("402 includes WWW-Authenticate: Payment header when crypto configured", async () => {
      const { app } = buildCryptoApp();

      const res = await app.request("http://localhost/api/data", {
        headers: { accept: "application/json", "user-agent": "curl/8.0" },
      });

      expect(res.status).toBe(402);
      const wwwAuth = res.headers.get("www-authenticate");
      expect(wwwAuth).toBeTruthy();
      expect(wwwAuth).toContain("Payment ");
      expect(wwwAuth).toContain('method="tempo"');
      expect(wwwAuth).toContain('intent="charge"');
    });

    it("402 omits crypto headers when crypto not configured", async () => {
      const { app } = buildHonoApp();

      const res = await app.request("http://localhost/api/data", {
        headers: { accept: "application/json", "user-agent": "curl/8.0" },
      });

      expect(res.status).toBe(402);
      expect(res.headers.get("payment-required")).toBeNull();
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(res.headers.get("x-payment-protocol")).toBe("gate/v1");
    });
  });
});
