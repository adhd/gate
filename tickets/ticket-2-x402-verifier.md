# Ticket 2: x402 protocol verifier

## Project context

`gate` (npm: `@daviejpg/gate-pay`) is a middleware that adds pay-per-call billing to APIs. It currently supports Stripe Checkout for human customers and returns 402 JSON for API clients. The codebase is TypeScript (ES2022, ESM), uses Hono and Express adapters, has 76 tests passing via Vitest, and one runtime dependency (stripe). Built with tsup.

We're adding x402 and MPP crypto payment support so AI agents can pay USDC per-call without Stripe Checkout. This ticket implements the x402 server-side protocol: building payment-required headers, verifying payment signatures via a facilitator service, and settling payments after response.

GitHub: https://github.com/adhd/gate
Branch: `feat/x402-verifier`
Depends on: Ticket 1 (crypto types and config) is already merged. `ResolvedConfig` has a `crypto` field (see types below).

## Relevant types from Ticket 1 (already in codebase)

After Ticket 1, `ResolvedConfig` includes:

```typescript
crypto: {
  address: string;
  pricePerCallUsd: number;
  amountSmallestUnit: string;   // e.g. "5000" for $0.005 with 6 decimals
  networks: string[];            // CAIP-2 format: ["eip155:8453"]
  facilitatorUrl: string;
  mppSecret: string;
  asset: string;                 // token contract address
  assetDecimals: number;         // 6 for USDC
} | null;
```

`GateResult` includes a new variant:

```typescript
| { action: "pass_crypto"; payer: string; protocol: "x402" | "mpp"; txHash?: string }
```

## What to do

Create `src/crypto/x402.ts` with the full x402 protocol implementation. This file handles:

1. Building the `X402PaymentRequired` object that goes in 402 response headers
2. Encoding/decoding base64 payment headers
3. Detecting x402 payment headers on incoming requests
4. Verifying payments via the facilitator's POST /verify endpoint
5. Settling payments via the facilitator's POST /settle endpoint
6. Test mode: auto-verify without HTTP calls when the facilitator URL contains "gate.test"

USDC contract addresses:

- Base mainnet (eip155:8453): `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Base Sepolia (eip155:84532): `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

x402 facilitator API:

- POST `{facilitatorUrl}/verify` with body `{ x402Version: 2, paymentPayload, paymentRequirements }`
- POST `{facilitatorUrl}/settle` with body `{ x402Version: 2, paymentPayload, paymentRequirements }`

Test mode rule: if `facilitatorUrl` contains `"gate.test"`, return success results immediately without making any HTTP call. This lets developers test locally.

## File to create: `src/crypto/x402.ts`

Write this exact file:

```typescript
import type { ResolvedConfig } from "../types.js";

// USDC contract addresses by CAIP-2 network
const USDC_ADDRESSES: Record<string, string> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

// --- Types ---

export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: X402PaymentRequirements[];
}

export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface X402PaymentPayload {
  x402Version: number;
  resource?: { url: string };
  accepted: X402PaymentRequirements;
  payload: Record<string, unknown>;
}

export interface X402VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface X402SettleResult {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

// --- Header building ---

/**
 * Build the PaymentRequired object for x402 402 responses.
 * `cost` is the credit cost of this route (default 1). The base amount
 * from config is multiplied by cost to get the total.
 */
export function buildX402PaymentRequired(
  config: ResolvedConfig,
  requestUrl: string,
  cost: number,
): X402PaymentRequired {
  const crypto = config.crypto!;
  const amount = (BigInt(crypto.amountSmallestUnit) * BigInt(cost)).toString();

  return {
    x402Version: 2,
    resource: { url: requestUrl, mimeType: "application/json" },
    accepts: crypto.networks.map((network) => ({
      scheme: "exact",
      network,
      asset: crypto.asset || USDC_ADDRESSES[network] || "",
      amount,
      payTo: crypto.address,
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    })),
  };
}

/** Encode PaymentRequired to base64 for the PAYMENT-REQUIRED header */
export function encodePaymentRequired(pr: X402PaymentRequired): string {
  return Buffer.from(JSON.stringify(pr)).toString("base64");
}

/** Decode a base64-encoded payment payload (from PAYMENT-SIGNATURE or X-PAYMENT header) */
export function decodePaymentPayload(header: string): X402PaymentPayload {
  return JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
}

// --- Request detection ---

/** Check if a request has x402 payment headers */
export function hasX402Payment(headers: Record<string, string>): boolean {
  return !!(headers["payment-signature"] || headers["x-payment"]);
}

/**
 * Extract the x402 payment payload from request headers.
 * Returns null if no header found or if the payload is malformed.
 */
export function extractX402Payment(
  headers: Record<string, string>,
): X402PaymentPayload | null {
  const raw = headers["payment-signature"] || headers["x-payment"];
  if (!raw) return null;
  try {
    return decodePaymentPayload(raw);
  } catch {
    return null;
  }
}

// --- Facilitator client ---

/**
 * Verify a payment via the facilitator.
 *
 * In test mode (facilitatorUrl contains "gate.test"), returns a successful
 * verification immediately without making any HTTP call.
 */
export async function verifyX402Payment(
  facilitatorUrl: string,
  paymentPayload: X402PaymentPayload,
  paymentRequirements: X402PaymentRequirements,
): Promise<X402VerifyResult> {
  // Test mode: auto-verify
  if (facilitatorUrl.includes("gate.test")) {
    return {
      isValid: true,
      payer: (paymentPayload.payload?.payer as string) || "0xTestPayer",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${facilitatorUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements,
      }),
    });
  } catch (err) {
    return {
      isValid: false,
      invalidReason: `Facilitator unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    return {
      isValid: false,
      invalidReason: `Facilitator returned ${res.status}`,
    };
  }

  return res.json() as Promise<X402VerifyResult>;
}

/**
 * Settle a verified payment on-chain via the facilitator.
 *
 * In test mode (facilitatorUrl contains "gate.test"), returns a successful
 * settlement immediately without making any HTTP call.
 */
export async function settleX402Payment(
  facilitatorUrl: string,
  paymentPayload: X402PaymentPayload,
  paymentRequirements: X402PaymentRequirements,
): Promise<X402SettleResult> {
  // Test mode: auto-settle
  if (facilitatorUrl.includes("gate.test")) {
    return {
      success: true,
      transaction: "0xTestTxHash",
      network: paymentRequirements.network || "eip155:84532",
      payer: (paymentPayload.payload?.payer as string) || "0xTestPayer",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${facilitatorUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements,
      }),
    });
  } catch (err) {
    return {
      success: false,
      transaction: "",
      network: "",
      errorReason: `Facilitator unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    return {
      success: false,
      transaction: "",
      network: "",
      errorReason: `Facilitator returned ${res.status}`,
    };
  }

  return res.json() as Promise<X402SettleResult>;
}
```

## Tests to create: `test/crypto/x402.test.ts`

Write this exact file:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildX402PaymentRequired,
  encodePaymentRequired,
  decodePaymentPayload,
  hasX402Payment,
  extractX402Payment,
  verifyX402Payment,
  settleX402Payment,
} from "../../src/crypto/x402.js";
import type { ResolvedConfig } from "../../src/types.js";
import { MemoryStore } from "../../src/store/memory.js";

function makeCryptoConfig(): ResolvedConfig {
  return {
    credits: { amount: 1000, price: 500, currency: "usd" },
    stripe: { secretKey: "sk_test_xxx", webhookSecret: "whsec_xxx" },
    store: new MemoryStore(),
    failMode: "open",
    baseUrl: null,
    routePrefix: "/__gate",
    productName: "API Access",
    productDescription: "",
    mode: "test",
    crypto: {
      address: "0x" + "a".repeat(40),
      pricePerCallUsd: 0.005,
      amountSmallestUnit: "5000",
      networks: ["eip155:8453"],
      facilitatorUrl: "https://gate.test/facilitator",
      mppSecret: "test-secret-key-32-bytes-long-xx",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      assetDecimals: 6,
    },
  };
}

describe("buildX402PaymentRequired", () => {
  it("returns correct structure with all fields", () => {
    const config = makeCryptoConfig();
    const result = buildX402PaymentRequired(
      config,
      "https://api.example.com/v1/data",
      1,
    );

    expect(result.x402Version).toBe(2);
    expect(result.resource.url).toBe("https://api.example.com/v1/data");
    expect(result.resource.mimeType).toBe("application/json");
    expect(result.accepts).toHaveLength(1);
    expect(result.accepts[0].scheme).toBe("exact");
    expect(result.accepts[0].network).toBe("eip155:8453");
    expect(result.accepts[0].asset).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
    expect(result.accepts[0].amount).toBe("5000");
    expect(result.accepts[0].payTo).toBe("0x" + "a".repeat(40));
    expect(result.accepts[0].maxTimeoutSeconds).toBe(60);
    expect(result.accepts[0].extra).toEqual({
      name: "USD Coin",
      version: "2",
    });
  });

  it("multiplies amount by cost", () => {
    const config = makeCryptoConfig();
    const result = buildX402PaymentRequired(
      config,
      "https://api.example.com/v1/data",
      5,
    );

    // 5000 * 5 = 25000
    expect(result.accepts[0].amount).toBe("25000");
  });

  it("generates accepts entry for each network", () => {
    const config = makeCryptoConfig();
    config.crypto!.networks = ["eip155:8453", "eip155:84532"];

    const result = buildX402PaymentRequired(
      config,
      "https://api.example.com/v1/data",
      1,
    );

    expect(result.accepts).toHaveLength(2);
    expect(result.accepts[0].network).toBe("eip155:8453");
    expect(result.accepts[1].network).toBe("eip155:84532");
  });
});

describe("encodePaymentRequired / decodePaymentPayload round-trip", () => {
  it("encodes and decodes correctly", () => {
    const config = makeCryptoConfig();
    const pr = buildX402PaymentRequired(
      config,
      "https://api.example.com/v1/data",
      1,
    );

    const encoded = encodePaymentRequired(pr);
    expect(typeof encoded).toBe("string");

    // Decode to verify it round-trips
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf-8"),
    );
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource.url).toBe("https://api.example.com/v1/data");
    expect(decoded.accepts[0].amount).toBe("5000");
  });

  it("decodePaymentPayload parses a base64 payment payload", () => {
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
      payload: { hash: "0xabc123" },
    };

    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    const decoded = decodePaymentPayload(encoded);

    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.network).toBe("eip155:8453");
    expect(decoded.payload.hash).toBe("0xabc123");
  });
});

describe("hasX402Payment", () => {
  it("returns true for payment-signature header", () => {
    expect(hasX402Payment({ "payment-signature": "abc123" })).toBe(true);
  });

  it("returns true for x-payment header", () => {
    expect(hasX402Payment({ "x-payment": "abc123" })).toBe(true);
  });

  it("returns false when neither header present", () => {
    expect(hasX402Payment({ authorization: "Bearer token123" })).toBe(false);
  });

  it("returns false for empty headers", () => {
    expect(hasX402Payment({})).toBe(false);
  });
});

describe("extractX402Payment", () => {
  it("extracts payment from payment-signature header", () => {
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
      payload: { payer: "0xPayer123" },
    };

    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    const result = extractX402Payment({ "payment-signature": encoded });

    expect(result).not.toBeNull();
    expect(result!.x402Version).toBe(2);
    expect(result!.payload.payer).toBe("0xPayer123");
  });

  it("extracts payment from x-payment header", () => {
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
      payload: {},
    };

    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    const result = extractX402Payment({ "x-payment": encoded });

    expect(result).not.toBeNull();
    expect(result!.x402Version).toBe(2);
  });

  it("returns null for missing headers", () => {
    expect(extractX402Payment({})).toBeNull();
  });

  it("returns null for malformed base64", () => {
    expect(
      extractX402Payment({ "payment-signature": "not-valid-json!!!" }),
    ).toBeNull();
  });

  it("returns null for valid base64 but invalid JSON", () => {
    const badBase64 = Buffer.from("this is not json").toString("base64");
    expect(extractX402Payment({ "payment-signature": badBase64 })).toBeNull();
  });
});

describe("verifyX402Payment", () => {
  const mockPayload = {
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
    payload: { payer: "0xPayer123" },
  };

  const mockRequirements = mockPayload.accepted;

  it("auto-verifies when facilitator URL contains gate.test", async () => {
    const result = await verifyX402Payment(
      "https://gate.test/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("0xPayer123");
  });

  it("auto-verifies with default payer when no payer in payload", async () => {
    const payloadNoPayer = { ...mockPayload, payload: {} };
    const result = await verifyX402Payment(
      "https://gate.test/facilitator",
      payloadNoPayer,
      mockRequirements,
    );

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("0xTestPayer");
  });

  it("calls facilitator /verify and returns success", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ isValid: true, payer: "0xRealPayer" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await verifyX402Payment(
      "https://x402.org/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://x402.org/facilitator/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: mockPayload,
          paymentRequirements: mockRequirements,
        }),
      },
    );
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe("0xRealPayer");

    vi.unstubAllGlobals();
  });

  it("returns invalid when facilitator returns non-OK status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await verifyX402Payment(
      "https://x402.org/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("400");

    vi.unstubAllGlobals();
  });

  it("returns invalid when fetch throws (network error)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network timeout"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await verifyX402Payment(
      "https://x402.org/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("Network timeout");

    vi.unstubAllGlobals();
  });
});

describe("settleX402Payment", () => {
  const mockPayload = {
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
    payload: { payer: "0xPayer123" },
  };

  const mockRequirements = mockPayload.accepted;

  it("auto-settles when facilitator URL contains gate.test", async () => {
    const result = await settleX402Payment(
      "https://gate.test/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0xTestTxHash");
    expect(result.network).toBe("eip155:8453");
    expect(result.payer).toBe("0xPayer123");
  });

  it("calls facilitator /settle and returns success", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          transaction: "0xRealTx",
          network: "eip155:8453",
          payer: "0xRealPayer",
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await settleX402Payment(
      "https://x402.org/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://x402.org/facilitator/settle",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: mockPayload,
          paymentRequirements: mockRequirements,
        }),
      },
    );
    expect(result.success).toBe(true);
    expect(result.transaction).toBe("0xRealTx");

    vi.unstubAllGlobals();
  });

  it("returns failure when facilitator returns non-OK status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await settleX402Payment(
      "https://x402.org/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(result.success).toBe(false);
    expect(result.transaction).toBe("");
    expect(result.errorReason).toContain("500");

    vi.unstubAllGlobals();
  });

  it("returns failure when fetch throws (network error)", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await settleX402Payment(
      "https://x402.org/facilitator",
      mockPayload,
      mockRequirements,
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toContain("Connection refused");

    vi.unstubAllGlobals();
  });
});
```

## Acceptance criteria

- `npx tsc --noEmit` passes
- `npm test` passes (all existing tests + new x402 tests)
- `npm run build` succeeds
- No new entries in `dependencies` in package.json (uses only built-in `fetch` and `Buffer`)
- Test mode auto-verify works without any HTTP calls
- Real facilitator calls use correct POST body format with `x402Version: 2`
- Network errors are caught and returned as structured results (never thrown)
