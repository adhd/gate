# gate

`gate` adds prepaid API credits to Hono and Express routes using Stripe Checkout.

## Current scope

What works now:

- Route middleware for Hono and Express.
- API key issuance after checkout success.
- Credit decrement on each valid request.
- Browser redirect flow + API/agent `402` JSON flow.
- Stripe Connect account targeting via `connectId`.

What is not in this package:

- Usage metering (this is credit-pack billing only).
- Subscriptions or invoicing.
- Hosted proxy.
- x402/MPP protocol headers (current non-browser response is JSON `402`).

## Request behavior

For a gated route:

1. Valid key with credits: request passes, credits decrement by 1.
2. No key + browser client: `302` redirect to Stripe Checkout.
3. No key + non-browser client: `402` JSON with `checkout_url`.
4. Valid key with zero credits: `402` JSON with refill `checkout_url`.

On infrastructure errors:

- `failMode: "open"` (default): allow request through.
- `failMode: "closed"`: return `503`.

## Install

```bash
npm install gate stripe
```

Install the adapter for your framework:

```bash
npm install hono
# or
npm install express
```

## Quickstart (Hono)

### 1. Mount gate

```ts
import { Hono } from "hono";
import { mountGate } from "gate/hono";

const app = new Hono();

const billing = mountGate({
  credits: { amount: 1000, price: 500 }, // 1000 calls for $5.00
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    connectId: process.env.STRIPE_CONNECT_ACCOUNT_ID, // optional
  },
});

app.use("/api/*", billing.middleware);
app.get("/api/data", (c) => c.json({ ok: true }));

const gateRoutes = new Hono();
billing.routes(gateRoutes);
app.route("/__gate", gateRoutes);
```

### 2. Verify flow in test mode

Set `GATE_MODE=test` and run your app.

First call (no key) should return `402`:

```bash
curl -i http://localhost:3000/api/data
```

Issue a test key through success route:

```bash
curl "http://localhost:3000/__gate/success?session_id=cs_test_demo" \
  -H "accept: application/json"
```

Use returned `api_key`:

```bash
API_KEY="gate_test_..."
curl -i http://localhost:3000/api/data \
  -H "Authorization: Bearer $API_KEY"
```

## Quickstart (Express)

```ts
import express from "express";
import { mountGate } from "gate/express";

const app = express();

const billing = mountGate({
  credits: { amount: 1000, price: 500 },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    connectId: process.env.STRIPE_CONNECT_ACCOUNT_ID,
  },
});

app.use("/api", billing.middleware);
app.get("/api/data", (_req, res) => res.json({ ok: true }));

// Mount before express.json() so webhook uses raw body for signature verification.
app.use("/__gate", billing.routes());

app.listen(3000);
```

## Required routes

`mountGate` exposes handlers that must be reachable:

- `GET /__gate/success?session_id=...`
- `POST /__gate/webhook`

`/success` is used for key issuance after checkout completion.
`/webhook` verifies Stripe signatures and handles `checkout.session.completed`.

## Live mode checklist

1. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
2. Expose `GET /__gate/success` and `POST /__gate/webhook` on your public base URL.
3. In Stripe, configure webhook endpoint to hit `/__gate/webhook`.
4. If using Stripe Connect direct charges, set `connectId` (`acct_...`).

## Key formats accepted

- `Authorization: Bearer gate_live_...` (or `gate_test_...`)
- `X-API-Key: gate_live_...`
- `?api_key=gate_live_...`

## Configuration reference

```ts
interface GateConfig {
  credits: {
    amount: number; // API calls in one credit pack
    price: number; // cents (500 = $5.00)
    currency?: string; // default: "usd"
  };
  stripe?: {
    secretKey?: string; // fallback: STRIPE_SECRET_KEY
    webhookSecret?: string; // fallback: STRIPE_WEBHOOK_SECRET
    connectId?: string; // optional Stripe account id (acct_xxx)
  };
  store?: CreditStore; // default: in-memory store
  failMode?: "open" | "closed"; // default: "open"
  baseUrl?: string; // optional callback base URL override
  productName?: string; // default: "API Access"
  productDescription?: string;
}
```

## Environment variables

- `GATE_MODE`
  - `live` (default): Stripe verification enabled.
  - `test`: no Stripe credentials required; checkout URLs are stubbed and success route can issue test keys directly.
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

## Store contract

Default `MemoryStore` is not persistent and is for local/testing use.

For production, pass a custom store with atomic decrement:

- `get(key): Promise<KeyRecord | null>`
- `set(key, record): Promise<void>`
- `decrement(key): Promise<number | null>`
- `delete(key): Promise<void>`

This package also includes `RedisStore` (`gate/store`):

```ts
import { createClient } from "redis";
import { RedisStore } from "gate/store";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const billing = mountGate({
  credits: { amount: 1000, price: 500 },
  store: new RedisStore({ client: redis, prefix: "gate:" }),
});
```

## Stripe Connect behavior

If `connectId` is set, checkout sessions are created on that connected account.
Current implementation applies a fixed 5% application fee.
