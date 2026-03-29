import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountGate } from "../../src/adapters/hono.js";

describe("end-to-end flow in test mode", () => {
  beforeEach(() => {
    process.env.GATE_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("full flow: 402 -> checkout success -> use key -> exhaust credits", async () => {
    const app = new Hono();
    const billing = mountGate({
      credits: { amount: 3, price: 100 },
    });

    app.use("/api/*", billing.middleware);
    app.get("/api/data", (c) => c.json({ data: "secret" }));

    const gateRoutes = new Hono();
    billing.routes(gateRoutes);
    app.route("/__gate", gateRoutes);

    // Step 1: Hit API without key, get 402
    const res1 = await app.request("http://localhost/api/data", {
      headers: { accept: "application/json", "user-agent": "test-agent" },
    });
    expect(res1.status).toBe(402);
    const body1 = await res1.json();
    expect(body1.error).toBe("payment_required");
    expect(body1.payment.pricing.credits).toBe(3);
    expect(body1.payment.pricing.amount).toBe(100);

    // Step 2: Simulate checkout success (test mode skips Stripe)
    const successRes = await app.request(
      "http://localhost/__gate/success?session_id=cs_test_flow_123",
      { headers: { accept: "application/json" } },
    );
    expect(successRes.status).toBe(200);
    const successBody = await successRes.json();
    expect(successBody.api_key).toMatch(/^gate_test_/);
    expect(successBody.credits).toBe(3);
    const apiKey = successBody.api_key;

    // Step 3: Use the key (3 credits)
    for (let i = 0; i < 3; i++) {
      const res = await app.request("http://localhost/api/data", {
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: "secret" });
      expect(res.headers.get("x-gate-credits-remaining")).toBe(String(2 - i));
    }

    // Step 4: Credits exhausted, get 402 again
    const res4 = await app.request("http://localhost/api/data", {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
    });
    expect(res4.status).toBe(402);
    const body4 = await res4.json();
    expect(body4.error).toBe("credits_exhausted");

    // Step 5: Buy more credits (new key)
    const successRes2 = await app.request(
      "http://localhost/__gate/success?session_id=cs_test_flow_456",
      { headers: { accept: "application/json" } },
    );
    expect(successRes2.status).toBe(200);
    const newKey = (await successRes2.json()).api_key;

    // Step 6: New key works
    const res6 = await app.request("http://localhost/api/data", {
      headers: {
        authorization: `Bearer ${newKey}`,
        accept: "application/json",
      },
    });
    expect(res6.status).toBe(200);
  });

  it("success handler is idempotent", async () => {
    const app = new Hono();
    const billing = mountGate({ credits: { amount: 10, price: 500 } });

    const gateRoutes = new Hono();
    billing.routes(gateRoutes);
    app.route("/__gate", gateRoutes);

    const res1 = await app.request(
      "http://localhost/__gate/success?session_id=cs_test_idempotent",
      { headers: { accept: "application/json" } },
    );
    const key1 = (await res1.json()).api_key;

    const res2 = await app.request(
      "http://localhost/__gate/success?session_id=cs_test_idempotent",
      { headers: { accept: "application/json" } },
    );
    const key2 = (await res2.json()).api_key;

    expect(key1).toBe(key2);
  });

  it("key retrieval endpoint is removed (security fix)", async () => {
    const app = new Hono();
    const billing = mountGate({ credits: { amount: 10, price: 500 } });

    const gateRoutes = new Hono();
    billing.routes(gateRoutes);
    app.route("/__gate", gateRoutes);

    // Issue a key
    await app.request(
      "http://localhost/__gate/success?session_id=cs_test_retrieve",
      { headers: { accept: "application/json" } },
    );

    // Verify /key endpoint no longer exists
    const keyRes = await app.request(
      "http://localhost/__gate/key?session_id=cs_test_retrieve",
    );
    expect(keyRes.status).toBe(404);
  });
});
