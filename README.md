# gate

Pay-per-call billing middleware for Hono and Express.

Someone hits your API without a key, they get a 402. Browsers get redirected to Stripe Checkout. API clients get JSON with pricing and a checkout URL. AI agents can pay with USDC via x402 or MPP. After payment, they get a key with credits that tick down on each call.

You add middleware and set a price. That's it.

```ts
import { Hono } from "hono";
import { gate } from "@daviejpg/gate-pay/hono";

const app = new Hono();
const g = gate({ credits: { amount: 1000, price: 500 } }); // 1000 calls for $5

app.use("/__gate/*", g.routes); // management endpoints
app.use("/api/*", g); // billing middleware
app.get("/api/data", (c) => c.json({ ok: true }));
```

Or if you'd rather not think about mounting routes separately:

```ts
app.use("/*", g); // handles both /__gate/* routes and billing
app.get("/api/data", (c) => c.json({ ok: true }));
```

## Install

```bash
npm install @daviejpg/gate-pay hono
```

Or `express` instead of `hono`. Stripe is the only runtime dependency.

## How it works

When a request hits a gated route:

1. **Valid key with credits** -- request passes through, credits deducted.
2. **No key, browser** -- 302 redirect to Stripe Checkout.
3. **No key, API/agent client** -- 402 JSON with `purchase_url` and pricing info.
4. **Key with zero credits** -- 402 JSON with a refill URL.
5. **Crypto payment header present** -- payment verified inline, request passes through.

If the store is unreachable, gate fails open (configurable to fail closed).

## Per-route cost

The default cost is 1 credit per call. For expensive routes:

```ts
app.get("/api/expensive", g.cost(10), handler);
```

## Test mode

Set `GATE_MODE=test` to skip Stripe and blockchain entirely. No credentials needed.

```bash
GATE_MODE=test node server.js

# get a 402 (the response body includes a test_key you can copy)
curl -i http://localhost:3000/api/data

# or get a test key explicitly
curl http://localhost:3000/__gate/test-key
# { "api_key": "gate_test_...", "credits": 1000, "mode": "test" }

# use it
curl http://localhost:3000/api/data -H "Authorization: Bearer gate_test_..."
```

Every 402 in test mode includes a `test_key` field with a ready-to-use key. `GET /__gate/test-key` also hands one out directly. The older `/__gate/success?session_id=cs_test_anything` flow still works too.

## Express

```ts
import express from "express";
import { gate } from "@daviejpg/gate-pay/express";

const app = express();
const g = gate({ credits: { amount: 1000, price: 500 } });

app.use("/__gate", g.routes); // management endpoints (mount before express.json)
app.use(express.json());
app.use("/api", g); // billing middleware
app.get("/api/data", (_req, res) => res.json({ ok: true }));

app.listen(3000);
```

## Routes

Gate registers these handlers under the route prefix (default `/__gate`):

| Endpoint             | Method | Auth | What it does                                                                                     |
| -------------------- | ------ | ---- | ------------------------------------------------------------------------------------------------ |
| `/__gate/buy`        | GET    | No   | Creates a Stripe Checkout session. Browsers get a redirect, JSON clients get `{ checkout_url }`. |
| `/__gate/success`    | GET    | No   | Verifies payment and issues an API key. Needs `?session_id=...`.                                 |
| `/__gate/status`     | GET    | Yes  | Returns `{ credits_remaining, created_at, last_used_at }` for the key.                           |
| `/__gate/pricing`    | GET    | No   | Returns `{ credits, price, currency, formatted }`.                                               |
| `/__gate/webhook`    | POST   | No   | Stripe webhook. Verifies signature, issues key as backup to `/success`.                          |
| `/__gate/test-key`   | GET    | No   | Test mode only. Returns a fresh key with full credits.                                           |
| `/__gate/buy-crypto` | POST   | No   | Pay USDC once to get a key with credits (see [AGENTS.md](./AGENTS.md)).                          |

## Going live

1. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` env vars (or pass them in config).
2. Set `baseUrl` to your public URL (e.g. `https://api.example.com`).
3. Point a Stripe webhook at `https://your-domain/__gate/webhook`.
4. Remove `GATE_MODE=test`.

## Crypto payments

Gate supports x402 and MPP so AI agents can pay USDC per-call without going through Stripe. See [AGENTS.md](./AGENTS.md) for the full protocol details, header formats, and implementation guide.

Quick version: add a `crypto` field to your config and agents can start paying immediately.

```ts
const g = gate({
  credits: { amount: 1000, price: 500 },
  crypto: {
    address: "0x1234...abcd", // your USDC wallet
    pricePerCall: 0.005, // $0.005 per call
    networks: ["base"], // default
  },
});
```

When crypto is configured, every 402 includes `PAYMENT-REQUIRED` (x402) and `WWW-Authenticate` (MPP) headers alongside the JSON body. An agent that speaks either protocol can read the header, build a payment, and retry.

> **Note:** MPP verification is HMAC-only. Gate verifies the challenge wasn't tampered with but does not verify the on-chain transaction. For production, verify the tx hash independently or use a settlement service.

## Key format

Gate looks for keys in this order:

- `Authorization: Bearer gate_live_...`
- `X-API-Key: gate_live_...`
- `?api_key=gate_live_...` (logs a warning -- don't do this)

Keys are `gate_live_` or `gate_test_` followed by 32 hex characters.

## Stores

Default is in-memory (fine for dev, gone on restart).

For production, use `RedisStore`:

```ts
import { createClient } from "redis";
import { RedisStore } from "@daviejpg/gate-pay/store";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const g = gate({
  credits: { amount: 1000, price: 500 },
  store: new RedisStore({ client: redis, prefix: "gate:" }),
});
```

Or implement `CreditStore` yourself (D1, KV, Supabase, Postgres, whatever):

```ts
interface CreditStore {
  get(key: string): Promise<KeyRecord | null>;
  set(key: string, record: KeyRecord): Promise<void>;
  decrement(key: string, amount?: number): Promise<DecrementResult>;
  delete(key: string): Promise<void>;
}
```

## Config

```ts
interface GateConfig {
  credits: {
    amount: number; // calls per credit pack
    price: number; // cents (500 = $5.00)
    currency?: string; // default: "usd"
  };
  stripe?: {
    secretKey?: string; // or STRIPE_SECRET_KEY env
    webhookSecret?: string; // or STRIPE_WEBHOOK_SECRET env
  };
  crypto?: {
    address: string; // USDC wallet (0x...)
    pricePerCall: number; // USD per call (e.g. 0.005)
    networks?: string[]; // default: ["base"]. "base", "base-sepolia"
    facilitatorUrl?: string; // default: "https://x402.org/facilitator"
    mppSecret?: string; // HMAC secret (32+ bytes). Or GATE_MPP_SECRET env
    asset?: string; // token contract address override
  };
  store?: CreditStore; // default: in-memory
  failMode?: "open" | "closed"; // default: "open"
  baseUrl?: string; // required in live mode
  routePrefix?: string; // default: "/__gate"
  productName?: string; // shown on Stripe Checkout
  productDescription?: string;
}
```

## Env vars

| Variable                | What                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `GATE_MODE`             | `"test"` skips Stripe and blockchain. Default: `"live"`.                 |
| `STRIPE_SECRET_KEY`     | Your Stripe secret key.                                                  |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the webhook.                                          |
| `GATE_MPP_SECRET`       | HMAC secret for MPP challenges (32+ bytes). Auto-generated in test mode. |

## CLI demo

```bash
npx @daviejpg/gate-pay
```

Starts a demo server in test mode with a joke API, request logging, and curl instructions. Good for poking around.

## License

MIT
