import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountGate } from "../../src/adapters/hono.js";
import {
  verifyX402Payment,
  settleX402Payment,
  buildX402PaymentRequired,
  encodePaymentRequired,
  decodePaymentPayload,
} from "../../src/crypto/x402.js";
import {
  buildMppChallenge,
  verifyMppCredential,
} from "../../src/crypto/mpp.js";
import { createHmac } from "node:crypto";

describe("crypto test mode", () => {
  beforeEach(() => {
    process.env.GATE_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  describe("x402 test facilitator", () => {
    it("auto-verifies in test mode", async () => {
      const result = await verifyX402Payment(
        "https://gate.test/facilitator",
        {
          x402Version: 2,
          accepted: {
            scheme: "exact",
            network: "eip155:84532",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            amount: "5000",
            payTo: "0x" + "a".repeat(40),
            maxTimeoutSeconds: 60,
            extra: {},
          },
          payload: { fromAddress: "0xMyWallet" },
        },
        {
          scheme: "exact",
          network: "eip155:84532",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          amount: "5000",
          payTo: "0x" + "a".repeat(40),
          maxTimeoutSeconds: 60,
          extra: {},
        },
        "test",
      );

      expect(result.isValid).toBe(true);
      expect(result.payer).toBe("0xMyWallet");
    });

    it("auto-settles in test mode", async () => {
      const result = await settleX402Payment(
        "https://gate.test/facilitator",
        {
          x402Version: 2,
          accepted: {
            scheme: "exact",
            network: "eip155:84532",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            amount: "5000",
            payTo: "0x" + "a".repeat(40),
            maxTimeoutSeconds: 60,
            extra: {},
          },
          payload: {},
        },
        {
          scheme: "exact",
          network: "eip155:84532",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          amount: "5000",
          payTo: "0x" + "a".repeat(40),
          maxTimeoutSeconds: 60,
          extra: {},
        },
        "test",
      );

      expect(result.success).toBe(true);
      expect(result.transaction).toContain("0xTestTxHash");
      expect(result.network).toBe("eip155:84532");
    });

    it("does not make HTTP calls in test mode", async () => {
      const result = await verifyX402Payment(
        "https://gate.test/facilitator",
        {
          x402Version: 2,
          accepted: {
            scheme: "exact",
            network: "eip155:84532",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            amount: "5000",
            payTo: "0x" + "a".repeat(40),
            maxTimeoutSeconds: 60,
            extra: {},
          },
          payload: {},
        },
        {
          scheme: "exact",
          network: "eip155:84532",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          amount: "5000",
          payTo: "0x" + "a".repeat(40),
          maxTimeoutSeconds: 60,
          extra: {},
        },
        "test",
      );
      expect(result.isValid).toBe(true);
    });
  });

  describe("end-to-end: x402 flow", () => {
    it("request -> 402 with crypto headers -> retry with x402 payment -> pass_crypto", async () => {
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
      app.get("/api/data", (c) => c.json({ ok: true }));

      const gateRoutes = new Hono();
      billing.routes(gateRoutes);
      app.route("/__gate", gateRoutes);

      // Step 1: Request without credentials -> 402
      const res1 = await app.request("http://localhost/api/data", {
        headers: { accept: "application/json", "user-agent": "curl/8.0" },
      });
      expect(res1.status).toBe(402);

      // Read the PAYMENT-REQUIRED header
      const prHeader = res1.headers.get("payment-required");
      expect(prHeader).toBeTruthy();

      const paymentRequired = JSON.parse(atob(prHeader!));
      expect(paymentRequired.x402Version).toBe(2);
      expect(paymentRequired.accepts.length).toBeGreaterThan(0);

      // Step 2: Build a payment payload from the requirements
      const accepted = paymentRequired.accepts[0];
      const paymentPayload = {
        x402Version: 2,
        resource: { url: "http://localhost/api/data" },
        accepted,
        payload: {
          signature: "0xFakeSignature",
          fromAddress: "0xTestAgent",
        },
      };

      // Encode as base64 for the payment-signature header
      const paymentSignature = btoa(JSON.stringify(paymentPayload));

      // Step 3: Retry with x402 payment header -> 200
      const res2 = await app.request("http://localhost/api/data", {
        headers: {
          accept: "application/json",
          "user-agent": "curl/8.0",
          "payment-signature": paymentSignature,
        },
      });

      expect(res2.status).toBe(200);
      expect(res2.headers.get("x-payment-protocol")).toBe("x402");
      expect(res2.headers.get("x-payment-payer")).toBe("0xTestAgent");

      const body = await res2.json();
      expect(body).toEqual({ ok: true });
    });
  });

  describe("end-to-end: MPP flow", () => {
    it("request -> 402 with MPP challenge -> build credential -> retry -> pass_crypto", async () => {
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
      app.get("/api/data", (c) => c.json({ ok: true }));

      const gateRoutes = new Hono();
      billing.routes(gateRoutes);
      app.route("/__gate", gateRoutes);

      // Step 1: Request without credentials -> 402
      const res1 = await app.request("http://localhost/api/data", {
        headers: { accept: "application/json", "user-agent": "curl/8.0" },
      });
      expect(res1.status).toBe(402);

      // Read the WWW-Authenticate header
      const wwwAuth = res1.headers.get("www-authenticate");
      expect(wwwAuth).toBeTruthy();
      expect(wwwAuth).toContain("Payment ");

      // Step 2: Parse the challenge from the header
      const parseField = (header: string, field: string): string => {
        const match = header.match(new RegExp(`${field}="([^"]+)"`));
        return match ? match[1] : "";
      };

      const challengeId = parseField(wwwAuth!, "id");
      const realm = parseField(wwwAuth!, "realm");
      const method = parseField(wwwAuth!, "method");
      const intent = parseField(wwwAuth!, "intent");
      const requestParam = parseField(wwwAuth!, "request");

      expect(challengeId).toBeTruthy();
      expect(realm).toBe("localhost");
      expect(method).toBe("tempo");
      expect(intent).toBe("charge");

      // Step 3: Build a credential that matches the challenge
      const credential = {
        challenge: {
          id: challengeId,
          realm,
          method,
          intent,
          request: requestParam,
        },
        source: "did:example:testagent",
        payload: { hash: "0xFakeTxHash123" },
      };

      const encodedCredential = Buffer.from(
        JSON.stringify(credential),
      ).toString("base64url");

      // Step 4: Retry with MPP credential -> 200
      const res2 = await app.request("http://localhost/api/data", {
        headers: {
          accept: "application/json",
          "user-agent": "curl/8.0",
          authorization: `Payment ${encodedCredential}`,
        },
      });

      expect(res2.status).toBe(200);
      expect(res2.headers.get("x-payment-protocol")).toBe("mpp");
      expect(res2.headers.get("x-payment-payer")).toBe("did:example:testagent");

      const body = await res2.json();
      expect(body).toEqual({ ok: true });
    });
  });

  describe("config test-mode defaults", () => {
    it("auto-generates mppSecret in test mode", () => {
      const billing = mountGate({
        credits: { amount: 100, price: 500 },
        crypto: {
          address: "0x" + "a".repeat(40),
          pricePerCall: 0.005,
        },
      });

      expect(billing.resolved.crypto).not.toBeNull();
      expect(billing.resolved.crypto!.mppSecret).toBeTruthy();
      expect(billing.resolved.crypto!.mppSecret.length).toBeGreaterThanOrEqual(
        32,
      );
    });

    it("sets facilitatorUrl to gate.test in test mode", () => {
      const billing = mountGate({
        credits: { amount: 100, price: 500 },
        crypto: {
          address: "0x" + "a".repeat(40),
          pricePerCall: 0.005,
        },
      });

      expect(billing.resolved.crypto!.facilitatorUrl).toContain("gate.test");
    });
  });
});
