# Ticket 6: Test mode for crypto payments

## Project context

`gate` (npm: `@daviejpg/gate-pay`) is a middleware that adds pay-per-call billing to APIs. It supports Stripe Checkout for human customers and returns 402 JSON for API clients. The codebase is TypeScript, uses Hono and Express adapters, has 76 tests passing, and one runtime dependency (stripe).

We are adding x402 and MPP crypto payment support so AI agents can pay USDC per-call without Stripe Checkout. Tickets 1-4 are already merged. Ticket 1 added crypto types, config resolution, and test-mode defaults (auto-generated `mppSecret`, facilitator URL set to `https://gate.test/facilitator`). Ticket 2 added `src/crypto/x402.ts` with the facilitator client (`verifyX402Payment`, `settleX402Payment`) and header builders. Ticket 3 added `src/crypto/mpp.ts` with HMAC challenge generation and credential verification. Ticket 4 wired both protocols into `src/core.ts`.

This ticket makes the x402 facilitator calls auto-succeed when the facilitator URL contains `gate.test`, so developers can test the full crypto payment flow locally without any blockchain or external service.

GitHub: https://github.com/adhd/gate
Branch: `feat/crypto-test-mode`

## What to do

1. Modify `verifyX402Payment` in `src/crypto/x402.ts` to short-circuit when the facilitator URL contains `gate.test`.
2. Modify `settleX402Payment` in `src/crypto/x402.ts` to short-circuit in the same way.
3. MPP needs no changes (HMAC verification is pure local crypto, no external calls).
4. Config already handles test-mode defaults from Ticket 1 (auto-generated `mppSecret`, `facilitatorUrl` set to `https://gate.test/facilitator`). No config changes needed.
5. Write end-to-end tests that exercise the full request lifecycle: initial 402, parse crypto headers, retry with payment, get `pass_crypto`.

## Changes

### 1. `src/crypto/x402.ts`

Modify `verifyX402Payment` to add a test-mode short-circuit at the top of the function, before the `fetch` call:

```typescript
export async function verifyX402Payment(
  facilitatorUrl: string,
  paymentPayload: X402PaymentPayload,
  paymentRequirements: X402PaymentRequirements,
): Promise<X402VerifyResult> {
  // Test mode: auto-verify without calling facilitator
  if (facilitatorUrl.includes("gate.test")) {
    return {
      isValid: true,
      payer: (paymentPayload.payload?.fromAddress as string) || "0xTestPayer",
    };
  }

  const res = await fetch(`${facilitatorUrl}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    }),
  });
  if (!res.ok) {
    return {
      isValid: false,
      invalidReason: `Facilitator returned ${res.status}`,
    };
  }
  return res.json();
}
```

Modify `settleX402Payment` the same way:

```typescript
export async function settleX402Payment(
  facilitatorUrl: string,
  paymentPayload: X402PaymentPayload,
  paymentRequirements: X402PaymentRequirements,
): Promise<X402SettleResult> {
  // Test mode: auto-settle without calling facilitator
  if (facilitatorUrl.includes("gate.test")) {
    return {
      success: true,
      transaction: "0xTestTxHash_" + Date.now().toString(16),
      network: paymentRequirements.network || "eip155:84532",
      payer: (paymentPayload.payload?.fromAddress as string) || "0xTestPayer",
    };
  }

  const res = await fetch(`${facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    }),
  });
  if (!res.ok) {
    return {
      success: false,
      transaction: "",
      network: "",
      errorReason: `Facilitator returned ${res.status}`,
    };
  }
  return res.json();
}
```

### 2. `test/crypto/test-mode.test.ts` (new file)

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mountGate } from "../../src/adapters/hono.js";
import {
  verifyX402Payment,
  settleX402Payment,
  buildX402PaymentRequired,
  encodePaymentRequired,
  decodePaymentSignature,
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
    it("auto-verifies when facilitatorUrl contains gate.test", async () => {
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
      );

      expect(result.isValid).toBe(true);
      expect(result.payer).toBe("0xMyWallet");
    });

    it("auto-settles when facilitatorUrl contains gate.test", async () => {
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
      );

      expect(result.success).toBe(true);
      expect(result.transaction).toContain("0xTestTxHash");
      expect(result.network).toBe("eip155:84532");
    });

    it("does not make HTTP calls in test mode", async () => {
      // If this tried to fetch, it would throw because gate.test is not a real host.
      // The fact that it resolves proves the short-circuit works.
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
      // Extract fields from the WWW-Authenticate: Payment id="...", realm="...", ...
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
      // The credential includes the original challenge fields and a payer source
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
```

## Acceptance criteria

- `npx tsc --noEmit` passes
- `npm test` passes (all existing tests plus new test-mode tests)
- `npm run build` succeeds
- No new entries in `dependencies` in package.json
- `GATE_MODE=test` crypto payments work without any external service or blockchain
- `verifyX402Payment` returns `isValid: true` without making an HTTP call when the facilitator URL contains `gate.test`
- `settleX402Payment` returns `success: true` with a fake tx hash when the facilitator URL contains `gate.test`
- The x402 end-to-end test exercises the full lifecycle: 402 -> parse PAYMENT-REQUIRED header -> build payment payload -> retry with payment-signature header -> 200 with pass_crypto
- The MPP end-to-end test exercises the full lifecycle: 402 -> parse WWW-Authenticate challenge -> build credential from challenge fields -> retry with Authorization: Payment header -> 200 with pass_crypto
- Real facilitator is never called in test mode
