import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { mountGate } from "../../src/adapters/express.js";

beforeEach(() => {
  process.env.GATE_MODE = "test";
});
afterEach(() => {
  delete process.env.GATE_MODE;
});

describe("GET /__gate/test-key (Express)", () => {
  function createApp() {
    const app = express();
    const billing = mountGate({ credits: { amount: 5, price: 500 } });
    app.use("/__gate", billing.routes());
    app.use(express.json());
    app.use("/api", billing.middleware);
    app.get("/api/data", (_req, res) => res.json({ ok: true }));
    return { app, billing };
  }

  it("returns a fresh test key with credits", async () => {
    const { app } = createApp();
    const res = await request(app).get("/__gate/test-key");
    expect(res.status).toBe(200);
    expect(res.body.api_key).toMatch(/^gate_test_/);
    expect(res.body.credits).toBe(5);
    expect(res.body.mode).toBe("test");
  });

  it("returns a key that works on gated routes", async () => {
    const { app } = createApp();

    const keyRes = await request(app).get("/__gate/test-key");
    const apiKey = keyRes.body.api_key;

    const res = await request(app)
      .get("/api/data")
      .set("authorization", `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 403 when not in test mode", async () => {
    delete process.env.GATE_MODE;
    process.env.STRIPE_SECRET_KEY = "sk_live_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

    const app = express();
    const billing = mountGate({
      credits: { amount: 5, price: 500 },
      baseUrl: "https://api.example.com",
    });
    app.use("/__gate", billing.routes());

    const res = await request(app).get("/__gate/test-key");
    expect(res.status).toBe(403);

    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });
});
