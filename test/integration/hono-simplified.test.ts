import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { gate } from "../../src/adapters/hono.js";

beforeEach(() => {
  process.env.GATE_MODE = "test";
});
afterEach(() => {
  delete process.env.GATE_MODE;
});

describe("Hono simplified gate() API", () => {
  function createApp() {
    const app = new Hono();
    const g = gate({ credits: { amount: 3, price: 500 } });

    // Mount routes explicitly
    app.use("/__gate/*", g.routes);
    // Normal routes use default billing (cost=1)
    app.get("/api/data", g, (c) => c.json({ ok: true }));
    // Expensive route uses cost override (cost=2)
    app.get("/api/expensive", g.cost(2), (c) => c.json({ expensive: true }));

    return { app, g };
  }

  it("returns 402 for unauthenticated requests", async () => {
    const { app } = createApp();
    const res = await app.request("/api/data");
    expect(res.status).toBe(402);
  });

  it("g.routes handles /pricing", async () => {
    const { app } = createApp();
    const res = await app.request("/__gate/pricing");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credits).toBe(3);
    expect(body.price).toBe(500);
  });

  it("g.routes handles /success and issues a key", async () => {
    const { app } = createApp();
    const res = await app.request("/__gate/success?session_id=cs_test_1", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.api_key).toMatch(/^gate_test_/);
    expect(body.credits).toBe(3);
  });

  it("key from /success works on gated routes", async () => {
    const { app } = createApp();

    // Get a key
    const keyRes = await app.request(
      "/__gate/success?session_id=cs_test_flow",
      { headers: { accept: "application/json" } },
    );
    const { api_key } = await keyRes.json();

    // Use it
    const res = await app.request("/api/data", {
      headers: { authorization: `Bearer ${api_key}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(res.headers.get("x-gate-credits-remaining")).toBe("2");
  });

  it("g.cost(2) deducts 2 credits per call", async () => {
    const { app } = createApp();

    const keyRes = await app.request(
      "/__gate/success?session_id=cs_test_cost",
      { headers: { accept: "application/json" } },
    );
    const { api_key } = await keyRes.json();

    // Call expensive route (costs 2 of 3 credits)
    const res = await app.request("/api/expensive", {
      headers: { authorization: `Bearer ${api_key}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gate-credits-remaining")).toBe("1");

    // Call again (only 1 credit left, costs 2)
    const res2 = await app.request("/api/expensive", {
      headers: { authorization: `Bearer ${api_key}` },
    });
    expect(res2.status).toBe(402);
  });

  it("g.resolved exposes the resolved config", () => {
    const g = gate({ credits: { amount: 5, price: 100 } });
    expect(g.resolved.credits.amount).toBe(5);
    expect(g.resolved.mode).toBe("test");
  });
});

describe("Hono gate() wildcard mount", () => {
  it("handles management routes when mounted on /*", async () => {
    const app = new Hono();
    const g = gate({ credits: { amount: 3, price: 500 } });

    // Single mount -- handles both billing and management
    app.use("/*", g);
    app.get("/api/data", (c) => c.json({ ok: true }));

    // Management route should work
    const pricingRes = await app.request("/__gate/pricing");
    expect(pricingRes.status).toBe(200);
    const body = await pricingRes.json();
    expect(body.credits).toBe(3);

    // Billing should still work
    const billingRes = await app.request("/api/data");
    expect(billingRes.status).toBe(402);
  });

  it("issues keys and uses them through wildcard mount", async () => {
    const app = new Hono();
    const g = gate({ credits: { amount: 2, price: 500 } });

    app.use("/*", g);
    app.get("/api/data", (c) => c.json({ ok: true }));

    const keyRes = await app.request("/__gate/success?session_id=cs_test_wc", {
      headers: { accept: "application/json" },
    });
    expect(keyRes.status).toBe(200);
    const { api_key } = await keyRes.json();

    const res = await app.request("/api/data", {
      headers: { authorization: `Bearer ${api_key}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("Hono mountGate backward compat", () => {
  it("still works with the old API", async () => {
    const { mountGate } = await import("../../src/adapters/hono.js");
    const billing = mountGate({ credits: { amount: 3, price: 500 } });

    const app = new Hono();
    app.use("/api/*", billing.middleware);
    app.get("/api/data", (c) => c.json({ ok: true }));
    const gateRoutes = new Hono();
    billing.routes(gateRoutes);
    app.route("/__gate", gateRoutes);

    const res = await app.request("/api/data");
    expect(res.status).toBe(402);

    const pricingRes = await app.request("/__gate/pricing");
    expect(pricingRes.status).toBe(200);
  });
});
