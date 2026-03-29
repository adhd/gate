import { beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { mountGate } from "../../src/adapters/express.js";
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

function buildExpressApp() {
  const app = express();
  const billing = mountGate({
    credits: { amount: 100, price: 500 },
  });

  app.use("/__gate", billing.routes());
  app.use(express.json());
  app.use("/api", billing.middleware);
  app.get("/api/data", (_req, res) => res.json({ ok: true }));

  return { app, billing };
}

describe("express adapter integration", () => {
  beforeEach(() => {
    process.env.GATE_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("returns 402 for API client without key", async () => {
    const { app } = buildExpressApp();

    const res = await request(app)
      .get("/api/data")
      .set("accept", "application/json")
      .set("user-agent", "curl/8.0");

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("payment_required");
    expect(res.body.payment.purchase_url).toContain("gate.test/buy");
  });

  it("redirects browser client without key", async () => {
    const { app } = buildExpressApp();

    const res = await request(app)
      .get("/api/data")
      .set("accept", "text/html")
      .set(
        "user-agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      );

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("gate.test/buy");
  });

  it("passes and decrements with valid key", async () => {
    const { app, billing } = buildExpressApp();
    const key = generateKey("test");
    await billing.resolved.store.set(key, makeRecord(key, 2));

    const res = await request(app)
      .get("/api/data")
      .set("authorization", `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["x-gate-credits-remaining"]).toBe("1");
  });

  it("returns 402 credits_exhausted when key has zero credits", async () => {
    const { app, billing } = buildExpressApp();
    const key = generateKey("test");
    await billing.resolved.store.set(key, makeRecord(key, 0));

    const res = await request(app)
      .get("/api/data")
      .set("authorization", `Bearer ${key}`);

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("credits_exhausted");
  });

  it("returns 401 for invalid key", async () => {
    const { app } = buildExpressApp();

    const res = await request(app)
      .get("/api/data")
      .set("authorization", "Bearer gate_test_" + "0".repeat(32));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid API key");
  });
});
