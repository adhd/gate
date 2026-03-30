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

function buildApp() {
  const app = express();
  const billing = mountGate({
    credits: { amount: 50, price: 300 },
  });

  app.use("/__gate", billing.routes());
  app.use(express.json());
  app.use("/api", billing.middleware);
  app.get("/api/data", (_req, res) => res.json({ ok: true }));

  return { app, billing };
}

describe("express adapter route endpoints", () => {
  beforeEach(() => {
    process.env.GATE_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  // --- /buy endpoint ---
  describe("/buy", () => {
    it("redirects to checkout URL by default", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/__gate/buy");

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("gate.test/checkout");
    });

    it("returns JSON with checkout_url when accept: application/json", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get("/__gate/buy")
        .set("accept", "application/json");

      expect(res.status).toBe(200);
      expect(res.body.checkout_url).toContain("gate.test/checkout");
    });
  });

  // --- /success endpoint ---
  describe("/success", () => {
    it("returns 400 when session_id is missing", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get("/__gate/success")
        .set("accept", "application/json");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("session_id");
    });

    it("returns JSON with api_key when accept: application/json", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get("/__gate/success?session_id=cs_test_expr1")
        .set("accept", "application/json");

      expect(res.status).toBe(200);
      expect(res.body.api_key).toMatch(/^gate_test_/);
      expect(res.body.credits).toBe(50);
    });

    it("returns HTML page when accept is text/html", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get("/__gate/success?session_id=cs_test_expr2")
        .set("accept", "text/html");

      expect(res.status).toBe(200);
      expect(res.text).toContain("Your API Key");
      expect(res.text).toContain("gate_test_");
    });
  });

  // --- /status endpoint ---
  describe("/status", () => {
    it("returns 401 when no API key provided", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/__gate/status");

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("API key required");
    });

    it("returns 401 for invalid API key", async () => {
      const { app } = buildApp();
      const res = await request(app)
        .get("/__gate/status")
        .set("authorization", "Bearer gate_test_" + "0".repeat(32));

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid");
    });

    it("returns credit status for valid key", async () => {
      const { app, billing } = buildApp();
      const key = generateKey("test");
      await billing.resolved.store.set(key, makeRecord(key, 25));

      const res = await request(app)
        .get("/__gate/status")
        .set("authorization", `Bearer ${key}`);

      expect(res.status).toBe(200);
      expect(res.body.credits_remaining).toBe(25);
      expect(res.body.created_at).toBeTruthy();
      expect(res.body.last_used_at).toBeNull();
    });
  });

  // --- /pricing endpoint ---
  describe("/pricing", () => {
    it("returns pricing information", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/__gate/pricing");

      expect(res.status).toBe(200);
      expect(res.body.credits).toBe(50);
      expect(res.body.price).toBe(300);
      expect(res.body.currency).toBe("usd");
      expect(res.body.formatted).toContain("$3.00");
    });
  });

  // --- /webhook endpoint ---
  describe("/webhook", () => {
    it("returns 400 when stripe-signature header is missing", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/__gate/webhook").send("{}");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("stripe-signature");
    });
  });
});

describe("express crypto payment pass-through headers", () => {
  beforeEach(() => {
    process.env.GATE_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("sets X-Payment-Payer and X-Payment-Protocol on pass_crypto", async () => {
    const app = express();
    const billing = mountGate({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
      },
    });

    app.use("/api", billing.middleware);
    app.get("/api/data", (_req, res) => res.json({ ok: true }));

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
      payload: { payer: "0xExpressAgent" },
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");

    const res = await request(app)
      .get("/api/data")
      .set("payment-signature", encoded)
      .set("accept", "application/json");

    expect(res.status).toBe(200);
    expect(res.headers["x-payment-payer"]).toBe("0xExpressAgent");
    expect(res.headers["x-payment-protocol"]).toBe("x402");
  });
});

describe("express fail_open pass-through", () => {
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

    const app = express();
    const billing = mountGate({
      credits: { amount: 100, price: 500 },
      store: failStore,
      failMode: "open",
    });

    app.use("/api", billing.middleware);
    app.get("/api/data", (_req, res) => res.json({ ok: true }));

    const key = "gate_test_" + "a".repeat(32);
    const res = await request(app)
      .get("/api/data")
      .set("authorization", `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
