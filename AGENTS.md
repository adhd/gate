# Paying for gate-protected APIs

You're building an agent or client that needs to call an API protected by gate. This doc covers the wire protocol end to end: what you'll see, what to send back, and how to get it working in test mode before you touch real money.

## Quick start (test mode)

The API operator runs their server with `GATE_MODE=test`. No Stripe, no blockchain, no wallet. You can go from zero to authenticated API calls in four commands.

```bash
# 1. Hit a gated endpoint. You'll get a 402.
curl -s http://localhost:3000/api/data | jq .

# The response body includes a test_key you can copy directly:
# { "error": "payment_required", ..., "test_key": "gate_test_abc123..." }

# 2. Or grab a test key from the dedicated endpoint:
curl -s http://localhost:3000/__gate/test-key | jq .
# { "api_key": "gate_test_abc123...", "credits": 1000, "mode": "test" }

# 3. Use it:
curl -s http://localhost:3000/api/data \
  -H "Authorization: Bearer gate_test_abc123..."

# 4. Check your balance:
curl -s http://localhost:3000/__gate/status \
  -H "Authorization: Bearer gate_test_abc123..." | jq .
# { "credits_remaining": 999, "created_at": "...", "last_used_at": "..." }
```

In test mode, x402 crypto payments also auto-succeed. Send any well-formed payment payload and it'll pass without touching a blockchain or facilitator. MPP challenges use a real HMAC but no on-chain verification happens.

## What happens when you hit a gated endpoint

The server runs your request through this decision tree:

1. **Crypto payment header present?** (x402 or MPP) &rarr; Verify it. If valid, request passes through.
2. **Valid API key with credits?** &rarr; Deduct credits, request passes through.
3. **Valid API key, zero credits?** &rarr; 402 with a refill URL.
4. **Invalid API key?** &rarr; 401.
5. **No key, no crypto header?** &rarr; 402 with pricing and payment options.

Browsers (detected by Accept header) get a 302 redirect to Stripe Checkout instead of a 402.

## The 402 response

This is the most important thing to parse correctly. When the server rejects you, the 402 body tells you everything you need to pay.

### Response body

```json
{
  "error": "payment_required",
  "message": "This endpoint requires an API key. Purchase 1,000 calls for $5.00.",
  "payment": {
    "type": "checkout",
    "provider": "stripe",
    "purchase_url": "https://api.example.com/__gate/buy",
    "pricing": {
      "amount": 500,
      "currency": "usd",
      "credits": 1000,
      "formatted": "$5.00 for 1,000 API calls"
    }
  }
}
```

The `error` field is either `"payment_required"` (no key) or `"credits_exhausted"` (key ran out). When credits are exhausted, there's also a `key` field:

```json
{
  "error": "credits_exhausted",
  "key": { "id": "gate_live...ef01", "credits_remaining": 0 },
  ...
}
```

### When crypto is configured

The body adds a `crypto` field:

```json
{
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

And the response includes two extra headers:

| Header             | What it contains                                     |
| ------------------ | ---------------------------------------------------- |
| `PAYMENT-REQUIRED` | Base64-encoded x402 payment requirements (see below) |
| `WWW-Authenticate` | MPP challenge string (see below)                     |

Both headers are always present when crypto is configured. Pick whichever protocol you support.

### In test mode

The body includes a `test_key` field with a ready-to-use key:

```json
{
  "error": "payment_required",
  "test_key": "gate_test_a1b2c3d4...",
  ...
}
```

This key is already provisioned in the store with full credits. Grab it and go.

## Payment methods

### 1. API keys (via Stripe Checkout)

The simplest path. Pay once, get a key, use it until credits run out.

**Flow:**

```
GET /__gate/buy
  Accept: application/json
-->  { "checkout_url": "https://checkout.stripe.com/..." }

# Complete the Stripe Checkout flow, then:

GET /__gate/success?session_id=cs_live_abc123
  Accept: application/json
-->  { "api_key": "gate_live_abc123...", "credits": 1000 }
```

Without `Accept: application/json`, `/buy` returns a 302 redirect and `/success` returns an HTML page. For programmatic clients, always send the JSON accept header.

**Using the key:**

```
GET /api/data
Authorization: Bearer gate_live_abc123...

--> 200 OK
    X-Gate-Credits-Remaining: 999
```

Each request costs 1 credit by default. Some routes cost more (the server decides). When you hit zero, you get another 402 with the same payment options.

**Key format:** `gate_live_` or `gate_test_` followed by 32 hex characters. Gate checks for keys in this order:

1. `Authorization: Bearer gate_live_...`
2. `X-API-Key: gate_live_...`
3. `?api_key=gate_live_...` (works but the server logs a warning)

### 2. x402 (per-request crypto)

Pay USDC per call. No key needed. Every request is individually paid and settled on-chain.

**Step 1: Read the 402**

Decode the `PAYMENT-REQUIRED` response header (standard base64):

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/api/data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "5000",
      "payTo": "0x1234...abcd",
      "maxTimeoutSeconds": 60,
      "extra": { "name": "USD Coin", "version": "2" }
    }
  ]
}
```

Key fields:

- **`amount`** is in the token's smallest unit. USDC has 6 decimals, so `"5000"` = $0.005.
- **`network`** is a [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) chain ID. `eip155:8453` is Base mainnet, `eip155:84532` is Base Sepolia.
- **`accepts`** can list multiple networks. Pick one you support.
- **`asset`** is the USDC contract address on that network.

**Step 2: Build and send a payment**

Construct your payment payload, JSON-encode it, base64-encode that, and send it in the `payment-signature` header on a retry of the same request:

```
GET /api/data
payment-signature: <base64(JSON.stringify(payload))>
```

The payload:

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/api/data" },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:8453",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "amount": "5000",
    "payTo": "0x1234...abcd",
    "maxTimeoutSeconds": 60,
    "extra": { "name": "USD Coin", "version": "2" }
  },
  "payload": {
    "signature": "0x...",
    "fromAddress": "0xYourWallet..."
  }
}
```

`accepted` is one of the entries from the `accepts` array in the 402 -- copy it verbatim. `payload` contains your EIP-712 signature and wallet address. The `x-payment` header works identically if you prefer it.

**Step 3: Get your response**

If verification passes:

```
200 OK
X-Payment-Payer: 0xYourWallet...
X-Payment-Protocol: x402

{ ...your API response... }
```

Gate verifies through a facilitator service (`https://x402.org/facilitator` by default), then settles on-chain asynchronously. Verification blocks your request; settlement doesn't.

**In test mode:** Send any well-formed payload with a `fromAddress`. No real signature needed. Verification auto-succeeds.

### 3. Buy credits with crypto

A hybrid: pay USDC once to get a key with credits, like Stripe but without Stripe.

```
POST /__gate/buy-crypto
payment-signature: <base64-encoded x402 payment>
```

The payment amount needs to cover the full credit pack. If `pricePerCall` is $0.005 and the pack is 1000 credits, the total is $5.00 = `5000000` in USDC's smallest unit (6 decimals).

Response:

```json
{
  "api_key": "gate_live_abc123...",
  "credits": 1000,
  "tx_hash": "0x...",
  "network": "eip155:8453",
  "payer": "0xYourWallet..."
}
```

Then use the key exactly like a Stripe-purchased one: `Authorization: Bearer gate_live_abc123...`

### 4. MPP (Micropayment Protocol)

An alternative per-request crypto flow using HTTP authentication challenges. The server sends a `WWW-Authenticate` header; you respond with an `Authorization` header.

**Step 1: Read the challenge**

The `WWW-Authenticate` header on the 402 looks like:

```
Payment id="<hmac>", realm="api.example.com", method="tempo", intent="charge", request="<base64url>"
```

Decode the `request` field (base64url, not standard base64) to get the payment details:

```json
{
  "amount": "5000",
  "currency": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "recipient": "0x1234...abcd"
}
```

`amount` is in USDC smallest units (same as x402). `currency` is the token contract address. `recipient` is where to send payment.

**Step 2: Make the on-chain payment and respond**

Send the transaction, then build a credential with the tx hash and send it back:

```
GET /api/data
Authorization: Payment <base64url(JSON.stringify(credential))>
```

The credential:

```json
{
  "challenge": {
    "id": "<the hmac id from the challenge>",
    "realm": "api.example.com",
    "method": "tempo",
    "intent": "charge",
    "request": "<the request value from the challenge, as-is>"
  },
  "source": "did:pkh:eip155:8453:0xYourWallet",
  "payload": {
    "hash": "0x<your transaction hash>"
  }
}
```

Copy the challenge fields back exactly as you received them. `source` is your payer identifier (a DID, wallet address, whatever identifies you). `payload.hash` is the on-chain transaction hash.

**Step 3: Get your response**

```
200 OK
X-Payment-Payer: did:pkh:eip155:8453:0xYourWallet
X-Payment-Protocol: mpp

{ ...your API response... }
```

**Important:** Gate verifies the HMAC integrity of the challenge (proving the server issued it and nobody tampered with it) but does not verify your on-chain transaction. The server operator is responsible for checking `payload.hash` against the blockchain in production.

## Management endpoints

All under the route prefix (default `/__gate`):

| Endpoint      | Method | Auth         | What it does                                                                   |
| ------------- | ------ | ------------ | ------------------------------------------------------------------------------ |
| `/pricing`    | GET    | None         | Returns credit pack pricing.                                                   |
| `/buy`        | GET    | None         | Stripe Checkout. JSON clients get `{ checkout_url }`, browsers get a redirect. |
| `/success`    | GET    | None         | Verifies Stripe session, returns key + credits. Needs `?session_id=...`.       |
| `/buy-crypto` | POST   | x402 payment | Pay USDC, get a key with credits.                                              |
| `/status`     | GET    | API key      | Returns credit balance for the given key.                                      |
| `/test-key`   | GET    | None         | Test mode only. Returns a fresh key with full credits.                         |
| `/webhook`    | POST   | Stripe sig   | Stripe webhook. Backup key issuance path.                                      |

## Response headers reference

**On a successful request with a valid API key:**

```
X-Gate-Credits-Remaining: 999
```

**On a successful request with a crypto payment:**

```
X-Payment-Payer: 0xYourWallet...
X-Payment-Protocol: x402    (or "mpp")
```

**On every 402 response:**

```
X-Payment-Protocol: gate/v1
PAYMENT-REQUIRED: <base64>      (only when crypto is configured)
WWW-Authenticate: Payment ...   (only when crypto is configured)
```

## Network and asset reference

Gate uses [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) chain IDs. Only USDC is supported (6 decimals).

| Network      | CAIP-2 ID      | USDC contract                                |
| ------------ | -------------- | -------------------------------------------- |
| Base         | `eip155:8453`  | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Base Sepolia | `eip155:84532` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

**Amount conversion:** multiply the USD price by 10^6. So $0.005 = `5000`, $5.00 = `5000000`.

## Things worth knowing

- **Cost varies by route.** The server sets credit cost per endpoint (default 1). The `amount` in crypto challenges reflects the cost of that specific route, not the credit pack price.
- **x402 uses standard base64. MPP uses base64url.** Don't mix them up. x402 encoding is `Buffer.from(JSON.stringify(payload)).toString('base64')`. MPP encoding is base64url (URL-safe, no padding).
- **Settlement is async.** x402 verification blocks your request, but on-chain settlement happens after you get your response. If settlement fails, the server logs an error but your request already went through.
- **Fail-open by default.** If the credit store goes down, gate lets requests through rather than breaking the API. This is a safety net for the operator, not something you should depend on.
- **USDC only (for now).** The crypto path is hardcoded to USDC with 6 decimal places. The token contract address is resolved from the network automatically.
