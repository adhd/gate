# Ticket 3: MPP protocol verifier

## Project context

`gate` (npm: `@daviejpg/gate-pay`) is a middleware that adds pay-per-call billing to APIs. It currently supports Stripe Checkout for human customers and returns 402 JSON for API clients. The codebase is TypeScript (ES2022, ESM), uses Hono and Express adapters, has 76 tests passing via Vitest, and one runtime dependency (stripe). Built with tsup.

We're adding x402 and MPP crypto payment support so AI agents can pay USDC per-call without Stripe Checkout. This ticket implements the MPP (Micropayment Protocol) server-side protocol: generating HMAC-SHA256 challenges and verifying credentials on retry.

GitHub: https://github.com/adhd/gate
Branch: `feat/mpp-verifier`
Depends on: Ticket 1 (crypto types and config) is already merged. Can run in parallel with Ticket 2 (x402 verifier).

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

## How MPP works

MPP is a challenge-response protocol for micropayments. The flow:

1. Client sends a request without payment credentials.
2. Server returns 402 with a `WWW-Authenticate: Payment` header containing an HMAC-signed challenge.
3. Client pays on-chain, then retries with `Authorization: Payment <base64url-encoded-json-credential>` containing the challenge fields plus a transaction hash.
4. Server recomputes the HMAC to verify the challenge wasn't tampered with, checks expiry, and accepts the payment.

The HMAC-SHA256 is computed over pipe-delimited fields: `realm|method|intent|request|expires|digest|opaque`

The `request` field is a base64url-encoded JSON object containing `{ amount, currency, recipient }`.

Zero external dependencies. Uses `node:crypto` only.

## File to create: `src/crypto/mpp.ts`

Write this exact file:

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

// --- Types ---

export interface MppChallengeParams {
  /** API domain or realm identifier */
  realm: string;
  /** Payment method. Use 'tempo' for on-chain micropayments */
  method: string;
  /** Payment intent. Use 'charge' for pay-per-call */
  intent: string;
  /** Amount in smallest unit (e.g. "5000" for $0.005 USDC) */
  amount: string;
  /** Token contract address */
  currency: string;
  /** Wallet address to receive payment */
  recipient: string;
  /** Human-readable description of what the payment is for */
  description?: string;
  /** Challenge expiry in RFC 3339 format. Optional. */
  expires?: string;
}

export interface MppCredential {
  challenge: {
    id: string;
    realm: string;
    method: string;
    intent: string;
    request: string;
    expires?: string;
    digest?: string;
    opaque?: string;
  };
  /** Payer identifier (DID, wallet address, etc.) */
  source: string;
  /** Payment proof. For tempo method: { hash: "0x..." } */
  payload: Record<string, unknown>;
}

export interface MppVerifyResult {
  valid: boolean;
  payer?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

// --- Challenge generation ---

/**
 * Build the WWW-Authenticate: Payment header value.
 *
 * The challenge includes an HMAC-SHA256 `id` field computed over the
 * pipe-delimited fields: realm|method|intent|request|expires|digest|opaque.
 * This lets the server verify on the retry that the challenge wasn't
 * tampered with, without storing any server-side state.
 */
export function buildMppChallenge(
  params: MppChallengeParams,
  secretKey: string,
): string {
  const request = Buffer.from(
    JSON.stringify({
      amount: params.amount,
      currency: params.currency,
      recipient: params.recipient,
    }),
  ).toString("base64url");

  const expires = params.expires ?? "";
  const digest = "";
  const opaque = "";

  const hmacInput = [
    params.realm,
    params.method,
    params.intent,
    request,
    expires,
    digest,
    opaque,
  ].join("|");

  const id = createHmac("sha256", secretKey)
    .update(hmacInput)
    .digest("base64url");

  let header = `Payment id="${id}", realm="${params.realm}", method="${params.method}", intent="${params.intent}", request="${request}"`;
  if (expires) header += `, expires="${expires}"`;
  if (params.description) header += `, description="${params.description}"`;

  return header;
}

// --- Credential verification ---

/**
 * Verify an MPP credential from the Authorization: Payment header.
 *
 * The header value is `Payment <base64url-encoded-json>` where the JSON
 * is an MppCredential object. Verification recomputes the HMAC over the
 * challenge fields and uses constant-time comparison against the provided id.
 */
export function verifyMppCredential(
  authHeader: string,
  secretKey: string,
): MppVerifyResult {
  if (!authHeader.startsWith("Payment ")) {
    return { valid: false, error: "Not a Payment credential" };
  }

  let cred: MppCredential;
  try {
    const jsonStr = Buffer.from(
      authHeader.slice("Payment ".length),
      "base64url",
    ).toString("utf-8");
    cred = JSON.parse(jsonStr);
  } catch {
    return { valid: false, error: "Malformed credential" };
  }

  const { challenge } = cred;

  if (!challenge || !challenge.id || !challenge.realm || !challenge.request) {
    return { valid: false, error: "Incomplete challenge fields" };
  }

  // Recompute HMAC over the same pipe-delimited fields
  const hmacInput = [
    challenge.realm,
    challenge.method,
    challenge.intent,
    challenge.request,
    challenge.expires ?? "",
    challenge.digest ?? "",
    challenge.opaque ?? "",
  ].join("|");

  const expectedId = createHmac("sha256", secretKey)
    .update(hmacInput)
    .digest("base64url");

  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(expectedId);
  const b = Buffer.from(challenge.id);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, error: "Invalid challenge HMAC" };
  }

  // Check expiry if set
  if (challenge.expires && new Date(challenge.expires) < new Date()) {
    return { valid: false, error: "Challenge expired" };
  }

  return { valid: true, payer: cred.source, payload: cred.payload };
}

// --- Request detection ---

/** Check if a request has MPP payment credentials in the Authorization header */
export function hasMppPayment(headers: Record<string, string>): boolean {
  const auth = headers["authorization"] || "";
  return auth.startsWith("Payment ");
}
```

## Tests to create: `test/crypto/mpp.test.ts`

Write this exact file:

```typescript
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildMppChallenge,
  verifyMppCredential,
  hasMppPayment,
} from "../../src/crypto/mpp.js";
import type {
  MppChallengeParams,
  MppCredential,
} from "../../src/crypto/mpp.js";

const TEST_SECRET = "test-secret-key-that-is-at-least-32-bytes-long";

const BASE_PARAMS: MppChallengeParams = {
  realm: "api.example.com",
  method: "tempo",
  intent: "charge",
  amount: "5000",
  currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  recipient: "0x" + "a".repeat(40),
};

/**
 * Helper: parse the WWW-Authenticate header value into its fields.
 * Returns a Record of field name to value (unquoted).
 */
function parseChallengeHeader(header: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // Strip the "Payment " prefix
  const body = header.replace(/^Payment\s+/, "");
  // Match key="value" pairs
  const re = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    fields[match[1]] = match[2];
  }
  return fields;
}

/**
 * Helper: given a parsed challenge, build a valid MppCredential and encode
 * it as an Authorization header value.
 */
function buildAuthHeader(
  challengeFields: Record<string, string>,
  source: string,
  payload: Record<string, unknown>,
): string {
  const cred: MppCredential = {
    challenge: {
      id: challengeFields.id,
      realm: challengeFields.realm,
      method: challengeFields.method,
      intent: challengeFields.intent,
      request: challengeFields.request,
      expires: challengeFields.expires,
      digest: challengeFields.digest,
      opaque: challengeFields.opaque,
    },
    source,
    payload,
  };
  const encoded = Buffer.from(JSON.stringify(cred)).toString("base64url");
  return `Payment ${encoded}`;
}

describe("buildMppChallenge", () => {
  it("returns a valid WWW-Authenticate: Payment header string", () => {
    const header = buildMppChallenge(BASE_PARAMS, TEST_SECRET);

    expect(header).toMatch(/^Payment /);
    expect(header).toContain('realm="api.example.com"');
    expect(header).toContain('method="tempo"');
    expect(header).toContain('intent="charge"');
    expect(header).toContain('id="');
    expect(header).toContain('request="');
  });

  it("includes all required params (id, realm, method, intent, request)", () => {
    const header = buildMppChallenge(BASE_PARAMS, TEST_SECRET);
    const fields = parseChallengeHeader(header);

    expect(fields.id).toBeTruthy();
    expect(fields.realm).toBe("api.example.com");
    expect(fields.method).toBe("tempo");
    expect(fields.intent).toBe("charge");
    expect(fields.request).toBeTruthy();
  });

  it("encodes amount, currency, recipient in the request field", () => {
    const header = buildMppChallenge(BASE_PARAMS, TEST_SECRET);
    const fields = parseChallengeHeader(header);

    const decoded = JSON.parse(
      Buffer.from(fields.request, "base64url").toString("utf-8"),
    );
    expect(decoded.amount).toBe("5000");
    expect(decoded.currency).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(decoded.recipient).toBe("0x" + "a".repeat(40));
  });

  it("includes expires when provided", () => {
    const params = { ...BASE_PARAMS, expires: "2099-12-31T23:59:59Z" };
    const header = buildMppChallenge(params, TEST_SECRET);

    expect(header).toContain('expires="2099-12-31T23:59:59Z"');
  });

  it("includes description when provided", () => {
    const params = { ...BASE_PARAMS, description: "API call payment" };
    const header = buildMppChallenge(params, TEST_SECRET);

    expect(header).toContain('description="API call payment"');
  });

  it("omits expires and description when not provided", () => {
    const header = buildMppChallenge(BASE_PARAMS, TEST_SECRET);

    expect(header).not.toContain("expires=");
    expect(header).not.toContain("description=");
  });

  it("produces different IDs for different secrets", () => {
    const header1 = buildMppChallenge(BASE_PARAMS, TEST_SECRET);
    const header2 = buildMppChallenge(
      BASE_PARAMS,
      "different-secret-key-32-bytes!!!",
    );

    const fields1 = parseChallengeHeader(header1);
    const fields2 = parseChallengeHeader(header2);

    expect(fields1.id).not.toBe(fields2.id);
  });

  it("produces different IDs for different amounts", () => {
    const params2 = { ...BASE_PARAMS, amount: "10000" };
    const header1 = buildMppChallenge(BASE_PARAMS, TEST_SECRET);
    const header2 = buildMppChallenge(params2, TEST_SECRET);

    const fields1 = parseChallengeHeader(header1);
    const fields2 = parseChallengeHeader(header2);

    expect(fields1.id).not.toBe(fields2.id);
  });
});

describe("verifyMppCredential", () => {
  it("verifies a valid credential built from a matching challenge", () => {
    const header = buildMppChallenge(BASE_PARAMS, TEST_SECRET);
    const fields = parseChallengeHeader(header);

    const authHeader = buildAuthHeader(fields, "did:example:payer123", {
      hash: "0xabc123",
    });

    const result = verifyMppCredential(authHeader, TEST_SECRET);

    expect(result.valid).toBe(true);
    expect(result.payer).toBe("did:example:payer123");
    expect(result.payload).toEqual({ hash: "0xabc123" });
  });

  it("rejects a credential with tampered challenge id", () => {
    const header = buildMppChallenge(BASE_PARAMS, TEST_SECRET);
    const fields = parseChallengeHeader(header);

    // Tamper with the id
    fields.id = "tampered-id-value";

    const authHeader = buildAuthHeader(fields, "did:example:attacker", {
      hash: "0xfake",
    });

    const result = verifyMppCredential(authHeader, TEST_SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("HMAC");
  });

  it("rejects a credential signed with a different secret", () => {
    const header = buildMppChallenge(
      BASE_PARAMS,
      "wrong-secret-key-32-bytes-long!!",
    );
    const fields = parseChallengeHeader(header);

    const authHeader = buildAuthHeader(fields, "did:example:payer", {
      hash: "0xabc",
    });

    // Verify with the correct secret (should fail because challenge was signed with wrong one)
    const result = verifyMppCredential(authHeader, TEST_SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("HMAC");
  });

  it("rejects an expired challenge", () => {
    const params = {
      ...BASE_PARAMS,
      expires: "2020-01-01T00:00:00Z",
    };
    const header = buildMppChallenge(params, TEST_SECRET);
    const fields = parseChallengeHeader(header);

    const authHeader = buildAuthHeader(fields, "did:example:payer", {
      hash: "0xabc",
    });

    const result = verifyMppCredential(authHeader, TEST_SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("accepts a non-expired challenge", () => {
    const params = {
      ...BASE_PARAMS,
      expires: "2099-12-31T23:59:59Z",
    };
    const header = buildMppChallenge(params, TEST_SECRET);
    const fields = parseChallengeHeader(header);

    const authHeader = buildAuthHeader(fields, "did:example:payer", {
      hash: "0xabc",
    });

    const result = verifyMppCredential(authHeader, TEST_SECRET);

    expect(result.valid).toBe(true);
  });

  it("rejects malformed base64url", () => {
    const result = verifyMppCredential("Payment !!!not-base64!!!", TEST_SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Malformed");
  });

  it("rejects non-Payment auth header", () => {
    const result = verifyMppCredential("Bearer token123", TEST_SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Not a Payment");
  });

  it("rejects credential with missing challenge fields", () => {
    const incomplete = {
      challenge: { id: "abc" },
      source: "did:example:payer",
      payload: {},
    };
    const encoded = Buffer.from(JSON.stringify(incomplete)).toString(
      "base64url",
    );
    const result = verifyMppCredential(`Payment ${encoded}`, TEST_SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Incomplete");
  });
});

describe("hasMppPayment", () => {
  it("returns true for Authorization: Payment header", () => {
    expect(
      hasMppPayment({ authorization: "Payment eyJjaGFsbGVuZ2UiOnt9fQ" }),
    ).toBe(true);
  });

  it("returns false for Authorization: Bearer header", () => {
    expect(hasMppPayment({ authorization: "Bearer some-token" })).toBe(false);
  });

  it("returns false when no authorization header", () => {
    expect(hasMppPayment({})).toBe(false);
  });

  it("returns false for empty authorization header", () => {
    expect(hasMppPayment({ authorization: "" })).toBe(false);
  });
});

describe("round-trip: challenge -> credential -> verify", () => {
  it("full cycle succeeds with matching secret", () => {
    // 1. Server builds challenge
    const challengeHeader = buildMppChallenge(BASE_PARAMS, TEST_SECRET);
    const fields = parseChallengeHeader(challengeHeader);

    // 2. Client parses challenge, pays on-chain, builds credential
    const authHeader = buildAuthHeader(fields, "0xPayerWalletAddress", {
      hash: "0x1234567890abcdef",
    });

    // 3. Server verifies credential
    const result = verifyMppCredential(authHeader, TEST_SECRET);

    expect(result.valid).toBe(true);
    expect(result.payer).toBe("0xPayerWalletAddress");
    expect(result.payload).toEqual({ hash: "0x1234567890abcdef" });
  });

  it("full cycle with expires succeeds when not expired", () => {
    const params = {
      ...BASE_PARAMS,
      expires: "2099-12-31T23:59:59Z",
      description: "Pay for /v1/data",
    };

    const challengeHeader = buildMppChallenge(params, TEST_SECRET);
    const fields = parseChallengeHeader(challengeHeader);
    const authHeader = buildAuthHeader(fields, "0xPayer", {
      hash: "0xdeadbeef",
    });

    const result = verifyMppCredential(authHeader, TEST_SECRET);

    expect(result.valid).toBe(true);
    expect(result.payer).toBe("0xPayer");
  });
});
```

## Acceptance criteria

- `npx tsc --noEmit` passes
- `npm test` passes (all existing tests + new MPP tests)
- `npm run build` succeeds
- No new entries in `dependencies` in package.json (uses `node:crypto` only)
- Existing tests unaffected
- HMAC verification uses `timingSafeEqual` for constant-time comparison
- Challenge-credential round-trip works with matching secrets
- Tampered challenges are rejected
- Expired challenges are rejected
