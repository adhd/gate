# gate

Add pay-per-call billing to any API. Middleware for Hono and Express.

Your API returns a 402 when someone shows up without a key. Browsers get redirected to Stripe Checkout. API clients and agents get JSON with pricing and a checkout URL. After payment, they get a key with credits that decrement on each call.

You don't build any of this. You add middleware and set a price.

```ts
import { Hono } from "hono";
import { mountGate } from "@daviejpg/gate-pay/hono";

const app = new Hono();
const billing = mountGate({
  credits: { amount: 1000, price: 500 }, // 1000 calls for $5
});

app.use("/api/*", billing.middleware);
app.get("/api/data", (c) => c.json({ ok: true }));

const gateRoutes = new Hono();
billing.routes(gateRoutes);
app.route("/__gate", gateRoutes);
```

## Install

```bash
npm install @daviejpg/gate-pay hono
```

(Or `express` instead of `hono`. Stripe is bundled as a dependency of gate.)

## How it works

For any gated route:

1. Valid key with credits: request passes, credits deducted (1 by default, configurable per route via `cost`).
2. No key, browser client: 302 redirect to `/__gate/buy`.
3. No key, API/agent client: 402 JSON with `purchase_url` and pricing.
4. Key with zero credits: 402 JSON with a refill `purchase_url`.

If the store is unreachable, gate fails open by default (lets requests through). Configurable to fail closed.

## Test mode

Set `GATE_MODE=test` to skip Stripe entirely. No credentials needed.

```bash
# start your app
GATE_MODE=test node server.js

# get a 402
curl -i http://localhost:3000/api/data

# issue a test key
curl "http://localhost:3000/__gate/success?session_id=cs_test_1" \
  -H "accept: application/json"
# returns: { "api_key": "gate_test_...", "credits": 1000 }

# use it
curl http://localhost:3000/api/data -H "Authorization: Bearer gate_test_..."
```

## Express

```ts
import express from "express";
import { mountGate } from "@daviejpg/gate-pay/express";

const app = express();
const billing = mountGate({
  credits: { amount: 1000, price: 500 },
});

// mount gate routes BEFORE express.json() (webhook needs raw body)
app.use("/__gate", billing.routes());

app.use(express.json());
app.use("/api", billing.middleware);
app.get("/api/data", (_req, res) => res.json({ ok: true }));

app.listen(3000);
```

## Routes

`mountGate` registers five handlers under the route prefix (default `/__gate`):

| Endpoint          | Method | Auth | Description                                                                                          |
| ----------------- | ------ | ---- | ---------------------------------------------------------------------------------------------------- |
| `/__gate/buy`     | GET    | No   | Creates a Stripe Checkout session. Browsers get a 302 redirect; JSON clients get `{ checkout_url }`. |
| `/__gate/success` | GET    | No   | Verifies payment and issues an API key. Requires `?session_id=...`.                                  |
| `/__gate/status`  | GET    | Yes  | Returns `{ credits_remaining, created_at, last_used_at }` for the authenticated key.                 |
| `/__gate/pricing` | GET    | No   | Returns `{ credits, price, currency, formatted }`. No auth needed.                                   |
| `/__gate/webhook` | POST   | No   | Stripe webhook endpoint. Verifies signature, issues key as backup to `/success`.                     |

## Variable cost

The default middleware deducts 1 credit per call. For routes that cost more, use `billing.gate()`:

```ts
// Hono
app.use("/api/expensive/*", billing.gate({ cost: 10 }));
```

## Going live

1. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` env vars (or pass them in config).
2. Set `baseUrl` in config to your public URL (e.g. `https://api.example.com`). Required in live mode.
3. In Stripe, point a webhook at your `/__gate/webhook` URL.
4. Remove `GATE_MODE=test`.

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

> **WARNING:** MPP verification is HMAC-only. Gate verifies that the challenge was not tampered with, but does **not** verify the on-chain transaction referenced in `payload.hash`. For production use, you should independently verify the transaction hash against the blockchain or use a settlement service.

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

## Key formats

Gate checks for keys in this order:

- `Authorization: Bearer gate_live_...`
- `X-API-Key: gate_live_...`
- `?api_key=gate_live_...`

## Stores

Default is an in-memory store (fine for dev, gone on restart).

For production, use `RedisStore`:

```ts
import { createClient } from "redis";
import { RedisStore } from "@daviejpg/gate-pay/store";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

mountGate({
  credits: { amount: 1000, price: 500 },
  store: new RedisStore({ client: redis, prefix: "gate:" }),
});
```

Or implement the `CreditStore` interface with whatever you want (D1, KV, Supabase, Postgres):

```ts
type DecrementResult =
  | { status: "ok"; remaining: number }
  | { status: "not_found" }
  | { status: "exhausted" };

interface CreditStore {
  get(key: string): Promise<KeyRecord | null>;
  set(key: string, record: KeyRecord): Promise<void>;
  decrement(key: string, amount?: number): Promise<DecrementResult>;
  delete(key: string): Promise<void>;
}
```

## Config reference

```ts
interface GateConfig {
  credits: {
    amount: number; // calls per credit pack
    price: number; // in cents (500 = $5.00)
    currency?: string; // default: "usd"
  };
  stripe?: {
    secretKey?: string; // or STRIPE_SECRET_KEY env
    webhookSecret?: string; // or STRIPE_WEBHOOK_SECRET env
  };
  crypto?: {
    address: string; // USDC wallet (0x...)
    pricePerCall: number; // USD per call (e.g. 0.005)
    networks?: string[]; // default: ["base"]. Options: "base", "base-sepolia"
    facilitatorUrl?: string; // default: "https://x402.org/facilitator"
    mppSecret?: string; // HMAC secret (32+ bytes). Falls back to GATE_MPP_SECRET env
    asset?: string; // token contract address override
  };
  store?: CreditStore; // default: in-memory
  failMode?: "open" | "closed"; // default: "open"
  baseUrl?: string; // required in live mode
  routePrefix?: string; // default: "/__gate"
  productName?: string; // default: "API Access"
  productDescription?: string;
}
```

## Env vars

- `GATE_MODE`: `"test"` skips Stripe, stubs checkout URLs, issues test keys. Default: `"live"`.
- `STRIPE_SECRET_KEY`: your Stripe secret key.
- `STRIPE_WEBHOOK_SECRET`: signing secret for the webhook endpoint.
- `GATE_MPP_SECRET`: HMAC secret for MPP challenges (32+ bytes). Can also be set via `crypto.mppSecret` in config. Auto-generated in test mode.

## License

MIT
