# Crypto payments: implementation tickets

These tickets are designed for parallel execution on git worktrees. Merge in order (1 first, then 2+3 in parallel, then 4, then 5+6 in parallel, then 7).

---

## Ticket 1: Types and config for crypto

**Branch:** `feat/crypto-types`
**Merge first.** Everything else depends on this.

### What to do

Add crypto payment types and config resolution. No behavior changes. Just types and validation.

### Files to modify

**`src/types.ts`** -- add these types:

```typescript
export interface GateCryptoConfig {
  /** Wallet address to receive USDC payments (0x...) */
  address: string;
  /** Price per API call in USD (e.g. 0.005 for half a cent) */
  pricePerCall: number;
  /** Supported networks. Default: ['base'] */
  networks?: string[];
  /** x402 facilitator URL. Default: 'https://x402.org/facilitator' */
  facilitatorUrl?: string;
  /** Secret key for MPP HMAC challenges (32+ bytes, random). Falls back to GATE_MPP_SECRET env var. */
  mppSecret?: string;
  /** USDC contract address override. Default: Base mainnet USDC */
  asset?: string;
}
```

Add `crypto?: GateCryptoConfig` to `GateConfig` interface.

Add to `ResolvedConfig`:

```typescript
crypto: {
  address: string;
  pricePerCallUsd: number;
  amountSmallestUnit: string; // "5000" for $0.005 with 6 decimals
  networks: string[];         // CAIP-2 format: ["eip155:8453"]
  facilitatorUrl: string;
  mppSecret: string;
  asset: string;              // token contract address
  assetDecimals: number;      // 6 for USDC
} | null;
```

Add new GateResult variant:

```typescript
| { action: "pass_crypto"; payer: string; protocol: "x402" | "mpp"; txHash?: string }
```

Widen error status: `401 | 402 | 503` (need 402 for invalid crypto payment).

Add optional `crypto` field to `GateResponse402`:

```typescript
crypto?: {
  protocols: string[];
  address: string;
  network: string;
  asset: string;
  amount: string;
  amountFormatted: string;
}
```

**`src/config.ts`** -- modify `resolveConfig`:

- Accept `crypto` field from input
- Validate: address starts with `0x` and is 42 chars, pricePerCall > 0, mppSecret is present (from config or `GATE_MPP_SECRET` env var)
- Convert pricePerCall USD to smallest unit string: `Math.round(pricePerCall * 10^decimals).toString()`
- Map network shorthand to CAIP-2: `'base'` → `'eip155:8453'`, `'base-sepolia'` → `'eip155:84532'`
- Relax Stripe requirement: require at least one of `stripe` or `crypto` in live mode, not both
- Set `resolved.crypto = null` if crypto not configured

**`src/index.ts`** -- export new types: `GateCryptoConfig`.

### Tests to add

**`test/config.test.ts`** -- add tests:

- Config with crypto only (no stripe) in live mode: should not throw
- Config with neither stripe nor crypto in live mode: should throw
- Crypto address validation (must be 0x + 40 hex)
- Crypto pricePerCall must be positive
- Crypto mppSecret required in live mode
- USD to smallest unit conversion: 0.005 → "5000", 1.00 → "1000000", 0.001 → "1000"
- Network shorthand mapping: 'base' → 'eip155:8453'
- Default values: facilitatorUrl, asset, networks

### Acceptance criteria

- `npx tsc --noEmit` passes
- All existing tests pass (crypto is optional, nothing breaks)
- New config tests pass
- `npm run build` succeeds

---

## Ticket 2: x402 verifier

**Branch:** `feat/x402-verifier`
**Depends on:** Ticket 1 merged.

### What to do

Implement the x402 server-side protocol: build PAYMENT-REQUIRED headers, verify PAYMENT-SIGNATURE via facilitator, settle after response.

### Files to create

**`src/crypto/x402.ts`** (~100 lines):

```typescript
import type { ResolvedConfig } from "../types.js";

// USDC contract addresses by CAIP-2 network
const USDC_ADDRESSES: Record<string, string> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

// --- Header building ---

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

/** Build the PaymentRequired object for x402 402 responses */
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
      asset: crypto.asset || USDC_ADDRESSES[network] || crypto.asset,
      amount,
      payTo: crypto.address,
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    })),
  };
}

/** Encode PaymentRequired to base64 for the PAYMENT-REQUIRED header */
export function encodePaymentRequired(pr: X402PaymentRequired): string {
  return btoa(JSON.stringify(pr));
}

/** Decode PAYMENT-SIGNATURE header */
export function decodePaymentSignature(header: string): X402PaymentPayload {
  return JSON.parse(atob(header));
}

// --- Facilitator client ---

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

/** Verify a payment via the facilitator */
export async function verifyX402Payment(
  facilitatorUrl: string,
  paymentPayload: X402PaymentPayload,
  paymentRequirements: X402PaymentRequirements,
): Promise<X402VerifyResult> {
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

/** Settle a verified payment on-chain */
export async function settleX402Payment(
  facilitatorUrl: string,
  paymentPayload: X402PaymentPayload,
  paymentRequirements: X402PaymentRequirements,
): Promise<X402SettleResult> {
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

/** Check if a request has x402 payment headers */
export function hasX402Payment(headers: Record<string, string>): boolean {
  return !!(headers["payment-signature"] || headers["x-payment"]);
}

/** Extract and match the payment against requirements */
export function extractX402Payment(
  headers: Record<string, string>,
): X402PaymentPayload | null {
  const raw = headers["payment-signature"] || headers["x-payment"];
  if (!raw) return null;
  try {
    return decodePaymentSignature(raw);
  } catch {
    return null;
  }
}
```

### Tests to create

**`test/crypto/x402.test.ts`**:

- `buildX402PaymentRequired` returns correct structure with all fields
- `encodePaymentRequired` / `decodePaymentSignature` round-trip
- `hasX402Payment` detects both `payment-signature` and `x-payment` headers
- `extractX402Payment` returns null for missing/malformed headers
- `verifyX402Payment` with mocked fetch: success case, failure case, network error
- `settleX402Payment` with mocked fetch: success case, failure case
- Amount calculation with cost multiplier (cost=5, base amount 5000 → 25000)

### Acceptance criteria

- All new tests pass
- Existing tests unaffected
- No new dependencies in package.json
- Types compile clean

---

## Ticket 3: MPP verifier

**Branch:** `feat/mpp-verifier`
**Depends on:** Ticket 1 merged. Can run in parallel with Ticket 2.

### What to do

Implement MPP server-side protocol: generate HMAC-SHA256 challenges, verify credentials on retry.

### Files to create

**`src/crypto/mpp.ts`** (~100 lines):

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

// --- Challenge generation ---

export interface MppChallengeParams {
  realm: string; // API domain
  method: string; // 'tempo'
  intent: string; // 'charge'
  amount: string; // smallest unit
  currency: string; // token contract address
  recipient: string; // wallet address
  description?: string;
  expires?: string; // RFC 3339
}

/** Build the WWW-Authenticate: Payment header value */
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
  source: string; // payer DID
  payload: Record<string, unknown>; // { hash: "0x..." } for tempo
}

export interface MppVerifyResult {
  valid: boolean;
  payer?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

/** Verify an MPP credential from the Authorization: Payment header */
export function verifyMppCredential(
  authHeader: string,
  secretKey: string,
): MppVerifyResult {
  if (!authHeader.startsWith("Payment ")) {
    return { valid: false, error: "Not a Payment credential" };
  }

  let cred: MppCredential;
  try {
    cred = JSON.parse(
      Buffer.from(authHeader.slice("Payment ".length), "base64url").toString(),
    );
  } catch {
    return { valid: false, error: "Malformed credential" };
  }

  const { challenge } = cred;

  // Recompute HMAC
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

  // Constant-time comparison
  const a = Buffer.from(expectedId);
  const b = Buffer.from(challenge.id);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, error: "Invalid challenge HMAC" };
  }

  // Check expiry
  if (challenge.expires && new Date(challenge.expires) < new Date()) {
    return { valid: false, error: "Challenge expired" };
  }

  return { valid: true, payer: cred.source, payload: cred.payload };
}

/** Check if a request has MPP payment headers */
export function hasMppPayment(headers: Record<string, string>): boolean {
  const auth = headers["authorization"] || "";
  return auth.startsWith("Payment ");
}
```

### Tests to create

**`test/crypto/mpp.test.ts`**:

- `buildMppChallenge` returns valid WWW-Authenticate header string
- Challenge includes all required params (id, realm, method, intent, request)
- `verifyMppCredential` with valid credential (construct one using the same secret)
- `verifyMppCredential` rejects tampered challenge (wrong id)
- `verifyMppCredential` rejects expired challenge
- `verifyMppCredential` rejects malformed base64
- `verifyMppCredential` rejects non-Payment auth header
- `hasMppPayment` returns true for `Authorization: Payment xxx`
- `hasMppPayment` returns false for `Authorization: Bearer xxx`
- Round-trip: build challenge → construct credential with matching HMAC → verify succeeds

### Acceptance criteria

- All new tests pass
- Zero new dependencies (uses node:crypto only)
- Existing tests unaffected
- Types compile clean

---

## Ticket 4: Core integration

**Branch:** `feat/crypto-core`
**Depends on:** Tickets 1, 2, 3 all merged.

### What to do

Wire the x402 and MPP verifiers into `handleGatedRequest`. Add crypto info to 402 responses.

### Files to modify

**`src/core.ts`** -- add crypto verification before key check:

```typescript
import {
  hasX402Payment,
  extractX402Payment,
  verifyX402Payment,
  settleX402Payment,
  buildX402PaymentRequired,
} from "./crypto/x402.js";
import { hasMppPayment, verifyMppCredential } from "./crypto/mpp.js";

// In handleGatedRequest, BEFORE the apiKey check:

if (config.crypto) {
  // x402 check
  if (hasX402Payment(ctx.headers)) {
    const payment = extractX402Payment(ctx.headers);
    if (payment) {
      const requirements = buildX402PaymentRequired(config, ctx.url, cost);
      const matchedReq =
        requirements.accepts.find(
          (a) => a.network === payment.accepted.network,
        ) || requirements.accepts[0];

      const verification = await verifyX402Payment(
        config.crypto.facilitatorUrl,
        payment,
        matchedReq,
      );

      if (verification.isValid) {
        return {
          action: "pass_crypto",
          payer: verification.payer || "unknown",
          protocol: "x402" as const,
        };
      }
      return {
        action: "error",
        status: 402,
        message: verification.invalidReason || "Payment verification failed",
      };
    }
  }

  // MPP check
  if (hasMppPayment(ctx.headers)) {
    const auth = ctx.headers["authorization"] || "";
    const result = verifyMppCredential(auth, config.crypto.mppSecret);
    if (result.valid) {
      return {
        action: "pass_crypto",
        payer: result.payer || "unknown",
        protocol: "mpp" as const,
        txHash: (result.payload?.hash as string) || undefined,
      };
    }
    return {
      action: "error",
      status: 402,
      message: result.error || "Payment verification failed",
    };
  }
}

// ... existing key check follows unchanged
```

**`src/errors.ts`** -- modify `paymentRequired` and `creditsExhausted`:

- Accept optional `cryptoConfig` parameter
- If present, add `crypto` field to the response body:

```typescript
crypto: {
  protocols: ['x402', 'mpp'],
  address: cryptoConfig.address,
  network: cryptoConfig.networks[0],
  asset: 'USDC',
  amount: cryptoConfig.amountSmallestUnit,
  amountFormatted: formatPrice(cryptoConfig.pricePerCallUsd * 100, 'usd'),
}
```

**`src/core.ts`** -- pass crypto config to error builders:

```typescript
return {
  action: "payment_required",
  body: paymentRequired(config, purchaseUrl, config.crypto),
  status: 402,
};
```

### Files to create

**`src/crypto/index.ts`** -- re-export everything from x402.ts and mpp.ts.

### Tests to add

**`test/core.test.ts`** -- add tests:

- Request with `payment-signature` header + crypto config → calls facilitator (mock fetch), returns `pass_crypto`
- Request with `authorization: Payment xxx` + crypto config → verifies HMAC, returns `pass_crypto`
- Request with invalid x402 payment → returns error 402
- Request with invalid MPP credential → returns error 402
- Request with no crypto config → x402/MPP headers ignored, normal flow
- 402 response body includes `crypto` field when crypto configured
- 402 response body omits `crypto` field when crypto not configured

### Acceptance criteria

- All tests pass (existing + new)
- Crypto verification happens BEFORE key check
- Invalid crypto payments return 402 (not 401)
- Normal key-based flow unaffected when crypto not configured

---

## Ticket 5: Adapter 402 headers

**Branch:** `feat/crypto-headers`
**Depends on:** Ticket 4 merged. Can run in parallel with Ticket 6.

### What to do

Add x402 and MPP headers to 402 responses in both adapters. Handle `pass_crypto` result.

### Files to modify

**`src/adapters/hono.ts`**:

In `createMiddleware`, add `pass_crypto` to the switch:

```typescript
case "pass_crypto":
  c.header("X-Payment-Payer", result.payer);
  c.header("X-Payment-Protocol", result.protocol);
  await next();
  break;
```

In the `payment_required` case, add crypto headers when configured:

```typescript
case "payment_required":
  c.header("X-Payment-Protocol", "gate/v1");
  if (resolved.crypto) {
    // x402 header
    const x402 = buildX402PaymentRequired(resolved, c.req.url, cost);
    c.header("PAYMENT-REQUIRED", encodePaymentRequired(x402));
    // MPP header
    const mppChallenge = buildMppChallenge({
      realm: new URL(c.req.url).hostname,
      method: 'tempo',
      intent: 'charge',
      amount: resolved.crypto.amountSmallestUnit,
      currency: resolved.crypto.asset,
      recipient: resolved.crypto.address,
    }, resolved.crypto.mppSecret);
    c.header("WWW-Authenticate", mppChallenge);
  }
  return c.json(result.body, 402);
```

Import `buildX402PaymentRequired`, `encodePaymentRequired` from `../crypto/x402.js` and `buildMppChallenge` from `../crypto/mpp.js`.

**`src/adapters/express.ts`** -- identical changes adapted for Express API:

- `res.setHeader(...)` instead of `c.header(...)`
- Same header logic

### Tests to add

**`test/integration/hono.test.ts`** -- add:

- 402 response includes `PAYMENT-REQUIRED` header when crypto configured
- 402 response includes `WWW-Authenticate: Payment` header when crypto configured
- 402 response omits crypto headers when crypto not configured
- `pass_crypto` sets `X-Payment-Payer` and `X-Payment-Protocol` headers

**`test/integration/express.test.ts`** -- same tests adapted for Express.

### Acceptance criteria

- x402-aware clients can read the PAYMENT-REQUIRED header from any 402
- MPP-aware clients can read the WWW-Authenticate header from any 402
- Regular API clients still see the JSON body unchanged
- pass_crypto responses have correct headers
- Crypto headers only present when crypto is configured

---

## Ticket 6: Test mode for crypto

**Branch:** `feat/crypto-test-mode`
**Depends on:** Ticket 4 merged. Can run in parallel with Ticket 5.

### What to do

Make crypto payments testable without real blockchain or facilitator.

### Files to modify

**`src/crypto/x402.ts`** -- modify `verifyX402Payment`:

- If `facilitatorUrl` starts with `https://gate.test`, return `{ isValid: true, payer: '0xTestPayer' }` without calling anything
- Same for `settleX402Payment`: return `{ success: true, transaction: '0xTestTxHash', network: 'eip155:84532' }`

**`src/crypto/mpp.ts`** -- no changes needed (HMAC verification works locally, no external calls).

**Test mode config in `src/config.ts`**:

- When `mode === 'test'` and crypto is configured, set `facilitatorUrl` to `'https://gate.test/facilitator'`
- Auto-generate `mppSecret` if not provided in test mode (use `crypto.randomBytes(32).toString('hex')`)

### Tests to add

**`test/crypto/test-mode.test.ts`**:

- x402 payment with test facilitator URL auto-verifies
- MPP payment with auto-generated secret: build challenge → construct credential → verify → passes
- Full flow in test mode: request → 402 with crypto headers → retry with mock x402 payment → pass_crypto
- Full flow: request → 402 → retry with MPP credential built from the challenge → pass_crypto

### Acceptance criteria

- `GATE_MODE=test` crypto payments work without any external service
- Developers can test the full x402 and MPP flow locally
- Real facilitator is never called in test mode

---

## Ticket 7: README and demo update

**Branch:** `feat/crypto-docs`
**Depends on:** All previous tickets merged.

### What to do

Update README and demo to show crypto payment support.

### Files to modify

**`README.md`**:

- Add "Crypto payments" section after "Going live"
- Show config with `crypto` field
- Explain the three payment paths (Stripe, x402, MPP)
- Show example 402 response with all headers
- Document test mode for crypto
- Update the config reference with `GateCryptoConfig`

**`examples/demo.ts`**:

- Add a crypto payment step to the demo
- After showing Stripe credit flow, show:
  1. Request without key → 402 with crypto headers
  2. Retry with mock x402 PAYMENT-SIGNATURE → pass_crypto
  3. Show "Paid via x402" in output

**`package.json`**: bump version to 0.2.0.

### Acceptance criteria

- README accurately describes all three payment paths
- Demo shows crypto payment flow in test mode
- `npm run demo` works end-to-end
- Version bumped

---

## Dependency graph

```
Ticket 1 (types + config)
    |
    ├── Ticket 2 (x402 verifier)
    |
    ├── Ticket 3 (MPP verifier)
    |
    └── Ticket 4 (core integration) ← depends on 1, 2, 3
          |
          ├── Ticket 5 (adapter headers)
          |
          ├── Ticket 6 (test mode)
          |
          └── Ticket 7 (docs + demo) ← depends on all
```

Parallel execution: 2+3 together after 1. 5+6 together after 4. Total: 4 sequential steps.
