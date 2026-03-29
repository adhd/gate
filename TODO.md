# Gate v1 fix list

From 6 audit agents. Prioritized.

## P0: Must fix before shipping

- [ ] **Replace per-request checkout sessions with `/__gate/buy`**
      Session created on every 402 response. Bot hitting 100x/sec exhausts Stripe rate limits.
      Fix: stable `/__gate/buy` URL creates session on demand. 402 returns the stable URL.

- [ ] **Fix TOCTOU race in credit decrement**
      `store.get()` then `store.decrement()` oversells credits under concurrency.
      Fix: drop the `get()` guard. Make `decrement` return `'not_found' | 'exhausted' | { remaining: number }`.

- [ ] **Require baseUrl in live mode**
      Success URL built from untrusted Host header. Attacker sets Host: evil.com, steals session.
      Fix: throw in config.ts if live mode and no baseUrl.

- [ ] **Try/catch in success handler**
      Fake session_id hits Stripe retrieve, throws unhandled 500.
      Fix: wrap in try/catch, return 400.

- [ ] **Remove Connect from v1**
      Webhook routing is broken (platform secret vs connected account). Half-built feature.
      Fix: remove connectId from config, remove application_fee_amount logic. Ship when it works.

- [ ] **Add X-Gate-Credits-Remaining header on success**
      Consumer has no way to check balance. Requests succeed until sudden 402.
      Fix: set header in adapters after middleware passes.

- [ ] **Make route prefix configurable**
      `/__gate` is hardcoded in Stripe success URL. Developer mounts at different path, silent break.
      Fix: accept routePrefix in config, use it in stripe.ts.

- [ ] **Add key retrieval endpoint**
      Customer pays, gets key on HTML page. Closes tab, money gone.
      Fix: `GET /__gate/key?session_id=xxx` returns the key (already stored as session mapping).

## P1: Should have before publish

- [ ] Per-route credit costs (`gate({ cost: 10 })`)
- [ ] `GET /__gate/pricing` endpoint
- [ ] `GET /__gate/status` endpoint (balance check with API key)
- [ ] Restructured 402 response with `payment` object + headers
- [ ] Warn if MemoryStore used in live mode
- [ ] Simplify Hono adapter (routes() returns Hono instance, not mutation)
- [ ] Remove standalone `gate()` export (confusing, mountGate only)

## P2: Tests to add

- [ ] Fail-open on store error (get and decrement)
- [ ] Fail-closed on store error
- [ ] Invalid key returns 401
- [ ] Concurrent credit exhaustion (decrement returns null)
- [ ] MemoryStore unit tests (get, set, decrement, delete directly)
- [ ] Success handler HTML response
- [ ] Missing session_id returns 400
- [ ] Missing stripe-signature returns 400
- [ ] NaN for credits.amount (should throw)
- [ ] Config with custom currency, failMode, productName
- [ ] Error response body shapes (unit test paymentRequired/creditsExhausted)
- [ ] Key extraction priority (auth header > x-api-key > query param)
