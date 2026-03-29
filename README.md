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
npm install gate hono
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
  store?: CreditStore; // default: in-memory
  failMode?: "open" | "closed"; // default: "open"
  baseUrl?: string; // required in live mode, used for checkout callback URLs
  routePrefix?: string; // default: "/__gate"
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
