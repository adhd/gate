# Ticket 7: README and demo update for crypto payments

## Project context

`gate` (npm: `@daviejpg/gate-pay`) is a middleware that adds pay-per-call billing to APIs. It supports Stripe Checkout for human customers and returns 402 JSON for API clients. The codebase is TypeScript, uses Hono and Express adapters, and one runtime dependency (stripe).

All crypto payment tickets (1-6) are merged. Gate now supports three payment paths: Stripe Checkout (humans buy credit packs), x402 (AI agents pay USDC per-call via a facilitator), and MPP (agents present HMAC-authenticated payment credentials). In test mode, all three paths work without external services.

This ticket updates the README to document crypto payments, updates the demo to show the x402 flow, and bumps the version to 0.2.0.

GitHub: https://github.com/adhd/gate
Branch: `feat/crypto-docs`

## What to do

1. Update `README.md` with a new "Crypto payments" section, updated config reference, and updated env vars.
2. Update `examples/demo.ts` to demonstrate the x402 payment flow in test mode.
3. Bump version to `0.2.0` in `package.json`.

## Changes

### 1. `README.md`

Add the following section after the "Going live" section (after line 113 in the current README). Insert it before the "Key formats" section.

````markdown
## Crypto payments

Gate supports x402 and MPP so AI agents can pay USDC per-call without Stripe Checkout. Add a `crypto` field to your config:

```ts
const billing = mountGate({
  credits: { amount: 1000, price: 500 },
  crypto: {
    address: "0x1234...abcd", // your USDC wallet
    pricePerCall: 0.005, // $0.005 per call
    networks: ["base"], // default: ["base"]
  },
});
```
````

When crypto is configured, every 402 response includes two extra headers alongside the JSON body:

| Header             | Protocol | Value                                                                           |
| ------------------ | -------- | ------------------------------------------------------------------------------- |
| `PAYMENT-REQUIRED` | x402     | Base64-encoded payment requirements (network, asset, amount, payTo)             |
| `WWW-Authenticate` | MPP      | `Payment id="...", realm="...", method="tempo", intent="charge", request="..."` |

An agent that understands either protocol can read the header, build a payment, and retry the request.

### Three payment paths

1. **Stripe Checkout** (humans): Browser gets redirected to Stripe. After payment, they get an API key with credits.
2. **x402** (agents): Agent reads `PAYMENT-REQUIRED` header, signs a USDC transfer, sends it back in a `payment-signature` header. Gate verifies via a facilitator and lets the request through.
3. **MPP** (agents): Agent reads `WWW-Authenticate` challenge, builds an HMAC credential with a payment proof, sends it in `Authorization: Payment <credential>`. Gate verifies the HMAC and lets the request through.

### Example 402 response with crypto

```
HTTP/1.1 402 Payment Required
X-Payment-Protocol: gate/v1
PAYMENT-REQUIRED: eyJ4NDAyVm...  (base64 JSON)
WWW-Authenticate: Payment id="abc", realm="api.example.com", method="tempo", intent="charge", request="eyJhbW91bnQ..."
Content-Type: application/json

{
  "error": "payment_required",
  "message": "This endpoint requires an API key. Purchase 1,000 calls for $5.00.",
  "payment": {
    "type": "checkout",
    "provider": "stripe",
    "purchase_url": "https://api.example.com/__gate/buy",
    "pricing": { "amount": 500, "currency": "usd", "credits": 1000, "formatted": "$5.00 for 1,000 API calls" }
  },
  "crypto": {
    "protocols": ["x402", "mpp"],
    "address": "0x1234...abcd",
    "network": "eip155:8453",
    "asset": "USDC",
    "amount": "5000",
    "amountFormatted": "$0.01"
  }
}
```

### Test mode for crypto

In test mode (`GATE_MODE=test`), crypto works without any blockchain or facilitator:

- x402 verification auto-succeeds (no HTTP call to a facilitator)
- x402 settlement returns a fake tx hash
- MPP uses a locally auto-generated HMAC secret
- No wallet, no USDC, no testnet faucet needed

```bash
GATE_MODE=test node server.js
# 402 responses include PAYMENT-REQUIRED and WWW-Authenticate headers
# Retry with a payment-signature header and it passes through
```

````

Update the "Config reference" section. Replace the current `GateConfig` interface block with:

```markdown
```ts
interface GateConfig {
  credits: {
    amount: number;       // calls per credit pack
    price: number;        // in cents (500 = $5.00)
    currency?: string;    // default: "usd"
  };
  stripe?: {
    secretKey?: string;       // or STRIPE_SECRET_KEY env
    webhookSecret?: string;   // or STRIPE_WEBHOOK_SECRET env
  };
  crypto?: {
    address: string;          // USDC wallet (0x...)
    pricePerCall: number;     // USD per call (e.g. 0.005)
    networks?: string[];      // default: ["base"]. Options: "base", "base-sepolia"
    facilitatorUrl?: string;  // default: "https://x402.org/facilitator"
    mppSecret?: string;       // HMAC secret (32+ bytes). Falls back to GATE_MPP_SECRET env
    asset?: string;           // token contract address override
  };
  store?: CreditStore;        // default: in-memory
  failMode?: "open" | "closed"; // default: "open"
  baseUrl?: string;           // required in live mode
  routePrefix?: string;       // default: "/__gate"
  productName?: string;       // default: "API Access"
  productDescription?: string;
}
````

````

Update the "Env vars" section. Add these two new entries after `STRIPE_WEBHOOK_SECRET`:

```markdown
- `GATE_MPP_SECRET`: HMAC secret for MPP challenges (32+ bytes). Can also be set via `crypto.mppSecret` in config. Auto-generated in test mode.
````

### 2. `examples/demo.ts`

Replace the entire file with:

```typescript
/**
 * Self-contained demo: full billing lifecycle in the terminal.
 * Run: GATE_MODE=test npx tsx examples/demo.ts
 */
process.env.GATE_MODE = "test";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { mountGate } from "../src/adapters/hono.js";

const G = "\x1b[32m",
  R = "\x1b[31m",
  Y = "\x1b[33m",
  C = "\x1b[36m",
  D = "\x1b[2m",
  X = "\x1b[0m";
const app = new Hono();
const billing = mountGate({
  credits: { amount: 3, price: 500 },
  crypto: {
    address: "0x" + "a".repeat(40),
    pricePerCall: 0.005,
    networks: ["base-sepolia"],
  },
});

app.use("/api/*", billing.middleware);
app.get("/api/joke", (c) =>
  c.json({
    joke: "Why do programmers prefer dark mode? Because light attracts bugs.",
  }),
);
const gateRoutes = new Hono();
billing.routes(gateRoutes);
app.route("/__gate", gateRoutes);

const server = serve({ fetch: app.fetch, port: 0 }, async (info) => {
  const base = `http://localhost:${info.port}`;
  const json = (r: Response) => r.json();

  // Step 1: No key
  console.log(`\n${Y}1. Call without a key:${X}`);
  const r1 = await fetch(`${base}/api/joke`);
  const b1 = await r1.json();
  console.log(`${R}   402 ${b1.error}${X}`);
  console.log(`${D}   ${b1.message}${X}`);

  // Step 2: Buy credits via Stripe
  console.log(`\n${Y}2. Buy credits (test checkout):${X}`);
  const r2 = await fetch(`${base}/__gate/success?session_id=cs_test_demo`, {
    headers: { accept: "application/json" },
  }).then(json);
  console.log(`${G}   Got ${r2.credits} credits${X}`);
  console.log(`${C}   Key: ${r2.api_key}${X}`);
  const key = r2.api_key;

  // Step 3: Use key
  console.log(`\n${Y}3. Call with key (3 credits):${X}`);
  for (let i = 1; i <= 3; i++) {
    const r = await fetch(`${base}/api/joke`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const remaining = r.headers.get("x-gate-credits-remaining");
    const body = await r.json();
    console.log(
      `${G}   ${i}/3  200 remaining=${remaining}  ${D}${body.joke}${X}`,
    );
  }

  // Step 4: Exhausted
  console.log(`\n${Y}4. Credits exhausted:${X}`);
  const r4 = await fetch(`${base}/api/joke`, {
    headers: { authorization: `Bearer ${key}` },
  }).then(json);
  console.log(`${R}   402 ${r4.error}${X}`);
  console.log(`${D}   ${r4.message}${X}`);

  // Step 5: Crypto payment (x402)
  console.log(`\n${Y}5. Pay with x402 (no key needed):${X}`);

  // 5a: Get 402 with crypto headers
  const r5a = await fetch(`${base}/api/joke`, {
    headers: { accept: "application/json", "user-agent": "agent/1.0" },
  });
  const prHeader = r5a.headers.get("payment-required");
  console.log(`${D}   Got 402 with PAYMENT-REQUIRED header${X}`);

  // 5b: Parse payment requirements
  const paymentRequired = JSON.parse(atob(prHeader!));
  const accepted = paymentRequired.accepts[0];
  console.log(
    `${D}   Network: ${accepted.network}, Amount: ${accepted.amount} (smallest unit), PayTo: ${accepted.payTo}${X}`,
  );

  // 5c: Build x402 payment payload and retry
  const paymentPayload = {
    x402Version: 2,
    resource: { url: `${base}/api/joke` },
    accepted,
    payload: {
      signature: "0xFakeSignature",
      fromAddress: "0xAgentWallet123",
    },
  };
  const paymentSignature = btoa(JSON.stringify(paymentPayload));

  const r5b = await fetch(`${base}/api/joke`, {
    headers: {
      accept: "application/json",
      "user-agent": "agent/1.0",
      "payment-signature": paymentSignature,
    },
  });
  const b5b = await r5b.json();
  const payer = r5b.headers.get("x-payment-payer");
  const protocol = r5b.headers.get("x-payment-protocol");
  console.log(`${G}   200 via ${protocol}, payer: ${payer}${X}`);
  console.log(`${D}   ${b5b.joke}${X}`);

  console.log(
    `\n${G}Full billing lifecycle: Stripe credits + x402 crypto in one API.${X}\n`,
  );
  server.close();
  process.exit(0);
});
```

### 3. `package.json`

Change the version field:

```diff
- "version": "0.1.0",
+ "version": "0.2.0",
```

## Acceptance criteria

- `npx tsc --noEmit` passes
- `npm run build` succeeds
- `npm run demo` runs end-to-end, prints the Stripe credit flow and the x402 crypto payment flow, then exits cleanly
- README accurately describes all three payment paths (Stripe, x402, MPP)
- README shows the updated `GateConfig` interface with the `crypto` field
- README shows an example 402 response with all headers
- README documents `GATE_MPP_SECRET` env var
- Demo shows a 402 -> parse PAYMENT-REQUIRED header -> retry with payment-signature -> 200 flow
- Version is 0.2.0 in package.json
