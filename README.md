# gate

Stripe Checkout + API key credits middleware for Hono and Express.

## What this package does

`gate` puts a paid access layer in front of an API route:

1. Request has a valid key with credits left: pass through and decrement credits.
2. No key from a browser client: redirect to Stripe Checkout.
3. No key from an API/agent client: return `402` JSON with pricing + `checkout_url`.
4. Key exists but credits are exhausted: return `402` JSON with a refill `checkout_url`.

After a successful checkout, gate issues an API key (`gate_live_...` or `gate_test_...`) and stores the starting credit balance.

## What this package does not do (yet)

- No usage metering (credits only).
- No subscriptions or invoicing.
- No hosted proxy.
- No x402/MPP wire headers. Current non-browser flow is JSON `402`.

## Install

```bash
npm install gate stripe
```

Install one framework adapter:

```bash
npm install hono
# or
npm install express
```

## Quick start (Hono)

```ts
import { Hono } from "hono";
import { mountGate } from "gate/hono";

const app = new Hono();

const billing = mountGate({
  credits: { amount: 1000, price: 500 }, // 1000 calls for $5.00
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    // optional: direct charges to connected account
    connectId: process.env.STRIPE_CONNECT_ACCOUNT_ID,
  },
});

app.use("/api/*", billing.middleware);
app.get("/api/data", (c) => c.json({ ok: true }));

const gateRoutes = new Hono();
billing.routes(gateRoutes);
app.route("/__gate", gateRoutes);

export default app;
```

## Quick start (Express)

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

app.use("/__gate", billing.routes());

app.listen(3000);
```

If you use `express.json()` globally, mount `"/__gate"` before it so Stripe webhook signature verification still has raw body access.

## Required routes

`mountGate` exposes two route handlers that must be reachable by Stripe/browser callbacks:

- `GET /__gate/success?session_id=...`
- `POST /__gate/webhook`

The middleware creates Stripe checkout sessions with `success_url` pointing to `/__gate/success`.

## Authentication formats accepted

- `Authorization: Bearer gate_live_...` (or `gate_test_...`)
- `X-API-Key: gate_live_...`
- query param: `?api_key=gate_live_...`

## Configuration

```ts
interface GateConfig {
  credits: {
    amount: number;   // number of API calls in a pack
    price: number;    // cents, e.g. 500 = $5.00
    currency?: string; // default "usd"
  };
  stripe?: {
    secretKey?: string; // fallback STRIPE_SECRET_KEY
    webhookSecret?: string; // fallback STRIPE_WEBHOOK_SECRET
    connectId?: string; // optional Stripe Connect account id
  };
  store?: CreditStore; // default in-memory store
  failMode?: "open" | "closed"; // default "open"
  baseUrl?: string; // optional override for callback URL base
  productName?: string; // default "API Access"
  productDescription?: string;
}
```

## Environment variables

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `GATE_MODE`:
  - `live` (default): Stripe keys required.
  - `test`: Stripe keys not required, checkout URLs are stubbed (`https://gate.test/...`), and success flow can generate keys without Stripe verification.

## Store behavior

Default store is in-memory (`MemoryStore`) and is not persistent.

For production, pass a custom `store` implementing:

- `get(key)`
- `set(key, record)`
- `decrement(key)` (must be atomic)
- `delete(key)`

## Fail-open vs fail-closed

Default is `failMode: "open"`:

- If Stripe/store is unavailable, requests continue (`fail_open`) instead of taking down your API.

Set `failMode: "closed"` if you prefer strict blocking on billing infrastructure errors.
