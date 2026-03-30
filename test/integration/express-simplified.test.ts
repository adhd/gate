import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { gate } from "../../src/adapters/express.js";

beforeEach(() => {
  process.env.GATE_MODE = "test";
});
afterEach(() => {
  delete process.env.GATE_MODE;
});

describe("Express simplified gate() API", () => {
  function createApp() {
    const app = express();
    const g = gate({ credits: { amount: 3, price: 500 } });

    // Mount management routes
    app.use("/__gate", g.routes);
    // Normal route with default billing (cost=1)
    app.get("/api/data", g as any, (_req, res) => res.json({ ok: true }));
    // Expensive route with cost override (cost=2)
    app.get("/api/expensive", g.cost(2) as any, (_req, res) =>
      res.json({ expensive: true }),
    );

    return { app, g };
  }

  it("returns 402 for unauthenticated requests", async () => {
    const { app } = createApp();
    const res = await request(app).get("/api/data");
    expect(res.status).toBe(402);
  });

  it("g.routes handles /pricing", async () => {
    const { app } = createApp();
    const res = await request(app).get("/__gate/pricing");
    expect(res.status).toBe(200);
    expect(res.body.credits).toBe(3);
  });

  it("g.routes handles /success and issues a key", async () => {
    const { app } = createApp();
    const res = await request(app)
      .get("/__gate/success?session_id=cs_test_1")
      .set("accept", "application/json");
    expect(res.status).toBe(200);
    expect(res.body.api_key).toMatch(/^gate_test_/);
    expect(res.body.credits).toBe(3);
  });

  it("key from /success works on gated routes", async () => {
    const { app } = createApp();

    const keyRes = await request(app)
      .get("/__gate/success?session_id=cs_test_flow")
      .set("accept", "application/json");
    const apiKey = keyRes.body.api_key;

    const res = await request(app)
      .get("/api/data")
      .set("authorization", `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.headers["x-gate-credits-remaining"]).toBe("2");
  });

  it("g.cost(2) deducts 2 credits per call", async () => {
    const { app } = createApp();

    const keyRes = await request(app)
      .get("/__gate/success?session_id=cs_test_cost")
      .set("accept", "application/json");
    const apiKey = keyRes.body.api_key;

    const res = await request(app)
      .get("/api/expensive")
      .set("authorization", `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.headers["x-gate-credits-remaining"]).toBe("1");

    const res2 = await request(app)
      .get("/api/expensive")
      .set("authorization", `Bearer ${apiKey}`);
    expect(res2.status).toBe(402);
  });

  it("g.resolved exposes the resolved config", () => {
    const g = gate({ credits: { amount: 5, price: 100 } });
    expect(g.resolved.credits.amount).toBe(5);
  });
});

describe("Express mountGate backward compat", () => {
  it("still works with the old API", async () => {
    const { mountGate } = await import("../../src/adapters/express.js");
    const billing = mountGate({ credits: { amount: 3, price: 500 } });

    const app = express();
    app.use("/__gate", billing.routes());
    app.use(express.json());
    app.use("/api", billing.middleware);
    app.get("/api/data", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/api/data");
    expect(res.status).toBe(402);

    const pricingRes = await request(app).get("/__gate/pricing");
    expect(pricingRes.status).toBe(200);
  });
});
