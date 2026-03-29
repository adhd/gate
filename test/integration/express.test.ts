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
    stripeConnectId: null,
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

  app.use("/api", billing.middleware);
  app.get("/api/data", (_req, res) => res.json({ ok: true }));
  app.use("/__gate", billing.routes());

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
    expect(res.body.checkout_url).toContain("https://gate.test/checkout/");
  });

  it("redirects browser client without key", async () => {
    const { app } = buildExpressApp();

    const res = await request(app)
      .get("/api/data")
      .set("accept", "text/html")
      .set(
        "user-agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      )
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.header.location).toContain("https://gate.test/checkout/");
  });

  it("passes and decrements with valid key", async () => {
    const { app, billing } = buildExpressApp();
    const key = generateKey("test");
    await billing.resolved.store.set(key, makeRecord(key, 2));

    const res = await request(app)
      .get("/api/data")
      .set("authorization", `Bearer ${key}`)
      .set("accept", "application/json");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const updated = await billing.resolved.store.get(key);
    expect(updated?.credits).toBe(1);
  });

  it("returns 402 credits_exhausted when key has zero credits", async () => {
    const { app, billing } = buildExpressApp();
    const key = generateKey("test");
    await billing.resolved.store.set(key, makeRecord(key, 0));

    const res = await request(app)
      .get("/api/data")
      .set("authorization", `Bearer ${key}`)
      .set("accept", "application/json");

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("credits_exhausted");
    expect(res.body.checkout_url).toContain("https://gate.test/checkout/");
  });

  it("returns 400 when webhook signature verification fails", async () => {
    process.env.GATE_MODE = "live";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";

    const { app } = buildExpressApp();
    const res = await request(app)
      .post("/__gate/webhook")
      .set("content-type", "application/json")
      .set("stripe-signature", "t=1,v1=invalid")
      .send("{}");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Webhook verification failed");
  });
});
