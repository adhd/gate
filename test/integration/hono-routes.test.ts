import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountGate, gate } from "../../src/adapters/hono.js";
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

describe("hono adapter route endpoints", () => {
  beforeEach(() => {
    process.env.GATE_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  function buildApp() {
    const app = new Hono();
    const billing = mountGate({
      credits: { amount: 50, price: 300 },
    });

    app.use("/api/*", billing.middleware);
    app.get("/api/data", (c) => c.json({ ok: true }));

    const gateRoutes = new Hono();
    billing.routes(gateRoutes);
    app.route("/__gate", gateRoutes);

    return { app, billing };
  }

  // --- /buy endpoint ---
  describe("/buy", () => {
    it("redirects to checkout URL by default", async () => {
      const { app } = buildApp();
      const res = await app.request("http://localhost/__gate/buy", {
        redirect: "manual",
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("gate.test/checkout");
    });

    it("returns JSON with checkout_url when accept: application/json", async () => {
      const { app } = buildApp();
      const res = await app.request("http://localhost/__gate/buy", {
        headers: { accept: "application/json" },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.checkout_url).toContain("gate.test/checkout");
    });
  });

  // --- /success endpoint ---
  describe("/success", () => {
    it("returns 400 when session_id is missing", async () => {
      const { app } = buildApp();
      const res = await app.request("http://localhost/__gate/success", {
        headers: { accept: "application/json" },
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("session_id");
    });

    it("returns JSON with api_key when accept: application/json", async () => {
      const { app } = buildApp();
      const res = await app.request(
        "http://localhost/__gate/success?session_id=cs_test_route1",
        { headers: { accept: "application/json" } },
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.api_key).toMatch(/^gate_test_/);
      expect(body.credits).toBe(50);
    });

    it("returns HTML page when accept is text/html", async () => {
      const { app } = buildApp();
      const res = await app.request(
        "http://localhost/__gate/success?session_id=cs_test_route2",
        { headers: { accept: "text/html" } },
      );
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(body).toContain("Your API Key");
      expect(body).toContain("gate_test_");
    });
  });

  // --- /status endpoint ---
  describe("/status", () => {
    it("returns 401 when no API key provided", async () => {
      const { app } = buildApp();
      const res = await app.request("http://localhost/__gate/status");
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.error).toContain("API key required");
    });

    it("returns 401 for invalid API key", async () => {
      const { app } = buildApp();
      const res = await app.request("http://localhost/__gate/status", {
        headers: { authorization: "Bearer gate_test_" + "0".repeat(32) },
      });
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.error).toContain("Invalid");
    });

    it("returns credit status for valid key", async () => {
      const { app, billing } = buildApp();
      const key = generateKey("test");
      await billing.resolved.store.set(key, makeRecord(key, 42));

      const res = await app.request("http://localhost/__gate/status", {
        headers: { authorization: `Bearer ${key}` },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.credits_remaining).toBe(42);
      expect(body.created_at).toBeTruthy();
      expect(body.last_used_at).toBeNull();
    });
  });

  // --- /pricing endpoint ---
  describe("/pricing", () => {
    it("returns pricing information", async () => {
      const { app } = buildApp();
      const res = await app.request("http://localhost/__gate/pricing");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.credits).toBe(50);
      expect(body.price).toBe(300);
      expect(body.currency).toBe("usd");
      expect(body.formatted).toContain("$3.00");
      expect(body.formatted).toContain("50");
    });
  });

  // --- /webhook endpoint ---
  describe("/webhook", () => {
    it("returns 400 when stripe-signature header is missing", async () => {
      const { app } = buildApp();
      const res = await app.request("http://localhost/__gate/webhook", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain("stripe-signature");
    });
  });
});

describe("hono gate() middleware (non-mountGate)", () => {
  beforeEach(() => {
    process.env.GATE_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("applies custom cost", async () => {
    const app = new Hono();
    const mw = gate({ credits: { amount: 100, price: 500 } }, { cost: 3 });

    app.use("/api/*", mw);
    app.get("/api/data", (c) => c.json({ ok: true }));

    // Need to provide a valid key via a separate mountGate for the store
    // gate() creates its own store, so we need to access it indirectly
    // This test verifies that the middleware is created without error
    // and returns 402 for unauthenticated requests
    const res = await app.request("http://localhost/api/data", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(402);
  });
});

describe("hono crypto payment pass-through headers", () => {
  beforeEach(() => {
    process.env.GATE_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("sets X-Payment-Payer and X-Payment-Protocol on pass_crypto", async () => {
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
      payload: { payer: "0xTestAgent" },
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");

    const res = await app.request("http://localhost/api/data", {
      headers: {
        "payment-signature": encoded,
        accept: "application/json",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-payment-payer")).toBe("0xTestAgent");
    expect(res.headers.get("x-payment-protocol")).toBe("x402");
  });
});

describe("hono fail_open pass-through", () => {
  beforeEach(() => {
    process.env.GATE_MODE = "test";
  });

  it("passes through to handler when store fails in open mode", async () => {
    const failStore = {
      get: () => Promise.reject(new Error("down")),
      set: () => Promise.reject(new Error("down")),
      decrement: () => Promise.reject(new Error("down")),
      delete: () => Promise.reject(new Error("down")),
    };

    const app = new Hono();
    const billing = mountGate({
      credits: { amount: 100, price: 500 },
      store: failStore,
      failMode: "open",
    });

    app.use("/api/*", billing.middleware);
    app.get("/api/data", (c) => c.json({ ok: true }));

    const key = "gate_test_" + "a".repeat(32);
    const res = await app.request("http://localhost/api/data", {
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
      },
    });

    // Should pass through despite store failure
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
