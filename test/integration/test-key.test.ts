import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mountGate } from "../../src/adapters/hono.js";

beforeEach(() => {
  process.env.GATE_MODE = "test";
});
afterEach(() => {
  delete process.env.GATE_MODE;
});

describe("GET /__gate/test-key (Hono)", () => {
  function createApp() {
    const app = new Hono();
    const billing = mountGate({ credits: { amount: 5, price: 500 } });
    app.use("/api/*", billing.middleware);
    app.get("/api/data", (c) => c.json({ ok: true }));
    const gateRoutes = new Hono();
    billing.routes(gateRoutes);
    app.route("/__gate", gateRoutes);
    return { app, billing };
  }

  it("returns a fresh test key with credits", async () => {
    const { app } = createApp();
    const res = await app.request("/__gate/test-key");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.api_key).toMatch(/^gate_test_/);
    expect(body.credits).toBe(5);
    expect(body.mode).toBe("test");
    expect(body.message).toContain("Bearer");
  });

  it("returns a key that actually works on gated routes", async () => {
    const { app } = createApp();

    // Get test key
    const keyRes = await app.request("/__gate/test-key");
    const { api_key } = await keyRes.json();

    // Use it
    const res = await app.request("/api/data", {
      headers: { authorization: `Bearer ${api_key}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gate-credits-remaining")).toBe("4");
  });

  it("returns unique keys on each call", async () => {
    const { app } = createApp();

    const res1 = await app.request("/__gate/test-key");
    const res2 = await app.request("/__gate/test-key");

    const key1 = (await res1.json()).api_key;
    const key2 = (await res2.json()).api_key;

    expect(key1).not.toBe(key2);
  });

  it("returns 403 when not in test mode", async () => {
    delete process.env.GATE_MODE;
    // Need to set up live mode requirements
    process.env.STRIPE_SECRET_KEY = "sk_live_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

    const app = new Hono();
    const billing = mountGate({
      credits: { amount: 5, price: 500 },
      baseUrl: "https://api.example.com",
    });
    const gateRoutes = new Hono();
    billing.routes(gateRoutes);
    app.route("/__gate", gateRoutes);

    const res = await app.request("/__gate/test-key");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("test mode");

    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });
});

describe("test_key in 402 response body", () => {
  function createApp() {
    const app = new Hono();
    const billing = mountGate({ credits: { amount: 3, price: 500 } });
    app.use("/api/*", billing.middleware);
    app.get("/api/data", (c) => c.json({ ok: true }));
    const gateRoutes = new Hono();
    billing.routes(gateRoutes);
    app.route("/__gate", gateRoutes);
    return { app, billing };
  }

  it("includes test_key in 402 for unauthenticated requests in test mode", async () => {
    const { app } = createApp();
    const res = await app.request("/api/data");
    expect(res.status).toBe(402);

    const body = await res.json();
    expect(body.test_key).toMatch(/^gate_test_/);
  });

  it("test_key from 402 response is usable", async () => {
    const { app } = createApp();

    // Get 402 with test_key
    const res402 = await app.request("/api/data");
    const { test_key } = await res402.json();

    // Use it
    const res = await app.request("/api/data", {
      headers: { authorization: `Bearer ${test_key}` },
    });
    expect(res.status).toBe(200);
  });

  it("includes test_key in 402 for exhausted credits", async () => {
    const { app } = createApp();

    // Get a key with 3 credits
    const keyRes = await app.request("/__gate/test-key");
    const { api_key } = await keyRes.json();

    // Exhaust credits
    for (let i = 0; i < 3; i++) {
      await app.request("/api/data", {
        headers: { authorization: `Bearer ${api_key}` },
      });
    }

    // Next call should be 402 with test_key
    const res = await app.request("/api/data", {
      headers: { authorization: `Bearer ${api_key}` },
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("credits_exhausted");
    expect(body.test_key).toMatch(/^gate_test_/);
  });

  it("does NOT include test_key in live mode", async () => {
    delete process.env.GATE_MODE;
    process.env.STRIPE_SECRET_KEY = "sk_live_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

    const app = new Hono();
    const billing = mountGate({
      credits: { amount: 3, price: 500 },
      baseUrl: "https://api.example.com",
    });
    app.use("/api/*", billing.middleware);
    app.get("/api/data", (c) => c.json({ ok: true }));

    const res = await app.request("/api/data");
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.test_key).toBeUndefined();

    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });
});
