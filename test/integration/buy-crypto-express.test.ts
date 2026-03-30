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

function buildPaymentSignature(): string {
  const payload = {
    x402Version: 2,
    resource: { url: "http://localhost/__gate/buy-crypto" },
    accepted: {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "500000",
      payTo: "0x" + "a".repeat(40),
      maxTimeoutSeconds: 120,
      extra: {},
    },
    payload: {
      signature: "0xFakeSignature",
      fromAddress: "0xAgentWallet123",
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("POST /__gate/buy-crypto (Express)", () => {
  function createApp() {
    const app = express();
    const billing = mountGate({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
        networks: ["base-sepolia"],
      },
    });
    app.use("/__gate", billing.routes());
    app.use(express.json());
    app.use("/api", billing.middleware);
    app.get("/api/data", (_req, res) => res.json({ ok: true }));
    return { app, billing };
  }

  it("returns an API key with credits after valid payment", async () => {
    const { app } = createApp();
    const res = await request(app)
      .post("/__gate/buy-crypto")
      .set("payment-signature", buildPaymentSignature());

    expect(res.status).toBe(200);
    expect(res.body.api_key).toMatch(/^gate_test_/);
    expect(res.body.credits).toBe(100);
    expect(res.body.tx_hash).toBeTruthy();
  });

  it("returned key works on gated routes", async () => {
    const { app } = createApp();

    const buyRes = await request(app)
      .post("/__gate/buy-crypto")
      .set("payment-signature", buildPaymentSignature());
    const apiKey = buyRes.body.api_key;

    const res = await request(app)
      .get("/api/data")
      .set("authorization", `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
  });

  it("returns 400 when no payment header is present", async () => {
    const { app } = createApp();
    const res = await request(app).post("/__gate/buy-crypto");
    expect(res.status).toBe(400);
  });

  it("returns 404 when crypto is not configured", async () => {
    const app = express();
    const billing = mountGate({
      credits: { amount: 100, price: 500 },
    });
    app.use("/__gate", billing.routes());

    const res = await request(app)
      .post("/__gate/buy-crypto")
      .set("payment-signature", buildPaymentSignature());
    expect(res.status).toBe(404);
  });
});
