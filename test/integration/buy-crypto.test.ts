import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mountGate } from "../../src/adapters/hono.js";

beforeEach(() => {
  process.env.GATE_MODE = "test";
});
afterEach(() => {
  delete process.env.GATE_MODE;
});

function buildPaymentSignature(opts?: {
  payer?: string;
  network?: string;
}): string {
  const payload = {
    x402Version: 2,
    resource: { url: "http://localhost/__gate/buy-crypto" },
    accepted: {
      scheme: "exact",
      network: opts?.network || "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "500000", // 0.50 USDC
      payTo: "0x" + "a".repeat(40),
      maxTimeoutSeconds: 120,
      extra: {},
    },
    payload: {
      signature: "0xFakeSignature",
      fromAddress: opts?.payer || "0xAgentWallet123",
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("POST /__gate/buy-crypto (Hono)", () => {
  function createApp() {
    const app = new Hono();
    const billing = mountGate({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
        networks: ["base-sepolia"],
      },
    });
    app.use("/api/*", billing.middleware);
    app.get("http://localhost/api/data", (c) => c.json({ ok: true }));
    const gateRoutes = new Hono();
    billing.routes(gateRoutes);
    app.route("/__gate", gateRoutes);
    return { app, billing };
  }

  it("returns an API key with credits after valid payment", async () => {
    const { app } = createApp();
    const res = await app.request("http://localhost/__gate/buy-crypto", {
      method: "POST",
      headers: {
        "payment-signature": buildPaymentSignature(),
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.api_key).toMatch(/^gate_test_/);
    expect(body.credits).toBe(100);
    expect(body.tx_hash).toBeTruthy();
    expect(body.network).toBeTruthy();
    expect(body.payer).toBeTruthy();
  });

  it("returned key works on gated routes", async () => {
    const { billing } = createApp();

    // Build a separate app with the same store for the gated route test
    // (Hono route table can behave unexpectedly when mixing route() and use())
    const app2 = new Hono();
    const billing2 = mountGate({
      credits: { amount: 100, price: 500 },
      crypto: {
        address: "0x" + "a".repeat(40),
        pricePerCall: 0.005,
        networks: ["base-sepolia"],
      },
      store: billing.resolved.store,
    });
    app2.use("/api/*", billing2.middleware);
    app2.get("/api/data", (c) => c.json({ ok: true }));
    const gateRoutes2 = new Hono();
    billing2.routes(gateRoutes2);
    app2.route("/__gate", gateRoutes2);

    // Buy credits with crypto
    const buyRes = await app2.request("http://localhost/__gate/buy-crypto", {
      method: "POST",
      headers: {
        "payment-signature": buildPaymentSignature(),
      },
    });
    expect(buyRes.status).toBe(200);
    const { api_key } = await buyRes.json();

    // Use the key
    const res = await app2.request("http://localhost/api/data", {
      headers: {
        authorization: `Bearer ${api_key}`,
        accept: "application/json",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gate-credits-remaining")).toBe("99");
  });

  it("returns 400 when no payment header is present", async () => {
    const { app } = createApp();
    const res = await app.request("http://localhost/__gate/buy-crypto", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing payment");
  });

  it("returns 400 for malformed payment payload", async () => {
    const { app } = createApp();
    const res = await app.request("http://localhost/__gate/buy-crypto", {
      method: "POST",
      headers: {
        "payment-signature": "not-valid-base64-json",
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Malformed");
  });

  it("returns 404 when crypto is not configured", async () => {
    const app = new Hono();
    const billing = mountGate({
      credits: { amount: 100, price: 500 },
    });
    const gateRoutes = new Hono();
    billing.routes(gateRoutes);
    app.route("/__gate", gateRoutes);

    const res = await app.request("http://localhost/__gate/buy-crypto", {
      method: "POST",
      headers: {
        "payment-signature": buildPaymentSignature(),
      },
    });
    expect(res.status).toBe(404);
  });

  it("stores the key with crypto tx reference", async () => {
    const { app, billing } = createApp();

    const buyRes = await app.request("http://localhost/__gate/buy-crypto", {
      method: "POST",
      headers: {
        "payment-signature": buildPaymentSignature({ payer: "0xMyWallet" }),
      },
    });
    const { api_key } = await buyRes.json();

    // Check the stored record
    const record = await billing.resolved.store.get(api_key);
    expect(record).not.toBeNull();
    expect(record!.credits).toBe(100);
    expect(record!.stripeSessionId).toMatch(/^crypto_/);
  });

  it("works with x-payment header too", async () => {
    const { app } = createApp();
    const res = await app.request("http://localhost/__gate/buy-crypto", {
      method: "POST",
      headers: {
        "x-payment": buildPaymentSignature(),
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.api_key).toMatch(/^gate_test_/);
  });
});
