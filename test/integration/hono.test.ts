import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountGate } from "../../src/adapters/hono.js";
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
    expect(body.checkout_url).toContain("https://gate.test/checkout/");
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
    expect(res.headers.get("location")).toContain("https://gate.test/checkout/");
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
    expect(body.checkout_url).toContain("https://gate.test/checkout/");
  });

  it("returns 400 when webhook signature verification fails", async () => {
    process.env.GATE_MODE = "live";
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";

    const { app } = buildHonoApp();
    const res = await app.request("http://localhost/__gate/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=invalid",
      },
      body: "{}",
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Webhook verification failed");
  });
});
