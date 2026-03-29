# gate

Add pay-per-call billing to any API. Middleware for Hono and Express.

Your API returns a 402 when someone shows up without a key. Browsers get redirected to Stripe Checkout. API clients and agents get JSON with pricing and a checkout URL. After payment, they get a key with credits that decrement on each call.

You don't build any of this. You add middleware and set a price.

```ts
import { Hono } from "hono";
import { mountGate } from "gate/hono";

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
npm install gate stripe hono
```

(Or `express` instead of `hono`.)

## How it works

For any gated route:

1. Valid key with credits: request passes, 1 credit deducted.
2. No key, browser client: 302 redirect to Stripe Checkout.
3. No key, API/agent client: 402 JSON with `checkout_url` and pricing.
4. Key with zero credits: 402 JSON with a refill `checkout_url`.

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
import { mountGate } from "gate/express";

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

## Required routes

`mountGate` sets up two handlers you need to expose:

- `GET /__gate/success?session_id=...` (key issuance after checkout)
- `POST /__gate/webhook` (Stripe signature verification, backup key issuance)

## Going live

1. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` env vars (or pass them in config).
2. In Stripe, point a webhook at your `/__gate/webhook` URL.
3. Remove `GATE_MODE=test`.

If you're using Stripe Connect (money goes to a connected account with a 5% application fee), also set `connectId`:

```ts
mountGate({
  credits: { amount: 1000, price: 500 },
  stripe: {
    connectId: "acct_...",
  },
});
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
import { RedisStore } from "gate/store";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

mountGate({
  credits: { amount: 1000, price: 500 },
  store: new RedisStore({ client: redis, prefix: "gate:" }),
});
```

Or implement the `CreditStore` interface with whatever you want (D1, KV, Supabase, Postgres):

```ts
interface CreditStore {
  get(key: string): Promise<KeyRecord | null>;
  set(key: string, record: KeyRecord): Promise<void>;
  decrement(key: string): Promise<number | null>;
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
    connectId?: string; // Stripe Connect account (acct_...)
  };
  store?: CreditStore; // default: in-memory
  failMode?: "open" | "closed"; // default: "open"
  baseUrl?: string; // for checkout callback URLs
  productName?: string; // default: "API Access"
  productDescription?: string;
}
```

## Env vars

- `GATE_MODE`: `"test"` skips Stripe, stubs checkout URLs, issues test keys. Default: `"live"`.
- `STRIPE_SECRET_KEY`: your Stripe secret key.
- `STRIPE_WEBHOOK_SECRET`: signing secret for the webhook endpoint.

## License

MIT
