# Ticket 1: Add crypto payment types and config

## Project context

`gate` (npm: `@daviejpg/gate-pay`) is a middleware that adds pay-per-call billing to APIs. It currently supports Stripe Checkout for human customers and returns 402 JSON for API clients. The codebase is TypeScript, uses Hono and Express adapters, has 76 tests passing, and one runtime dependency (stripe).

We're adding x402 and MPP crypto payment support so AI agents can pay USDC per-call without Stripe Checkout. This ticket adds the types and config only. No behavior changes.

GitHub: https://github.com/adhd/gate
Branch: `feat/crypto-types`

## What to do

Add new TypeScript types for crypto payment configuration and extend the existing config resolver to accept and validate them. The crypto config is optional. When absent, everything works exactly as before.

## Changes

### 1. `src/types.ts`

Add this interface after `GateStripeConfig`:

```typescript
export interface GateCryptoConfig {
  /** Wallet address to receive USDC payments (0x + 40 hex chars) */
  address: string;
  /** Price per API call in USD (e.g. 0.005 for half a cent) */
  pricePerCall: number;
  /** Supported networks. Default: ['base']. Options: 'base', 'base-sepolia' */
  networks?: string[];
  /** x402 facilitator URL. Default: 'https://x402.org/facilitator' */
  facilitatorUrl?: string;
  /** Secret key for MPP HMAC challenges (32+ bytes). Falls back to GATE_MPP_SECRET env var. */
  mppSecret?: string;
  /** USDC contract address override. Default: looked up by network. */
  asset?: string;
}
```

Add `crypto?: GateCryptoConfig` to the `GateConfig` interface.

Add to `ResolvedConfig`:

```typescript
crypto: {
  address: string;
  pricePerCallUsd: number;
  amountSmallestUnit: string;
  networks: string[];
  facilitatorUrl: string;
  mppSecret: string;
  asset: string;
  assetDecimals: number;
} | null;
```

Add a new `GateResult` variant:

```typescript
| { action: "pass_crypto"; payer: string; protocol: "x402" | "mpp"; txHash?: string }
```

Widen the error status union to `401 | 402 | 503` (crypto payment failures return 402).

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

### 2. `src/config.ts`

Modify `resolveConfig` to handle the crypto field:

- If `input.crypto` is present, validate:
  - `address` starts with `0x` and is exactly 42 characters
  - `pricePerCall` is a positive finite number
  - `mppSecret` is present (from config or `GATE_MPP_SECRET` env var). In test mode, auto-generate with `crypto.randomBytes(32).toString('hex')` if missing.
- Convert `pricePerCall` USD to smallest unit: `Math.round(pricePerCall * Math.pow(10, decimals)).toString()` where decimals is 6 for USDC.
- Map network shorthands to CAIP-2:
  - `'base'` → `'eip155:8453'`
  - `'base-sepolia'` → `'eip155:84532'`
  - Strings already in CAIP-2 format (containing `:`) pass through unchanged
- Defaults: `networks: ['base']`, `facilitatorUrl: 'https://x402.org/facilitator'`, `assetDecimals: 6`
- Look up USDC contract address by network if `asset` not provided:
  - `eip155:8453` → `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
  - `eip155:84532` → `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- When `mode === 'test'` and crypto configured, override `facilitatorUrl` to `'https://gate.test/facilitator'`
- Relax Stripe requirement: currently throws if Stripe keys missing in live mode. Change to: throw if NEITHER stripe nor crypto is configured in live mode. Either one is sufficient.
- Set `resolved.crypto = null` if `input.crypto` is undefined.

### 3. `src/index.ts`

Add `GateCryptoConfig` to the type exports.

## Tests to add in `test/config.test.ts`

```typescript
it("accepts crypto config without stripe in live mode", () => {
  process.env.GATE_MODE = "live";
  const config = resolveConfig({
    credits: { amount: 100, price: 500 },
    crypto: {
      address: "0x" + "a".repeat(40),
      pricePerCall: 0.005,
      mppSecret: "test-secret-key-32-bytes-long-xx",
    },
    baseUrl: "https://api.example.com",
  });
  expect(config.crypto).not.toBeNull();
  expect(config.crypto!.amountSmallestUnit).toBe("5000");
});

it("throws when neither stripe nor crypto in live mode", () => {
  process.env.GATE_MODE = "live";
  expect(() =>
    resolveConfig({
      credits: { amount: 100, price: 500 },
      baseUrl: "https://api.example.com",
    }),
  ).toThrow(/stripe or crypto/i);
});

it("validates crypto address format", () => {
  process.env.GATE_MODE = "test";
  expect(() =>
    resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: { address: "not-an-address", pricePerCall: 0.005 },
    }),
  ).toThrow(/address/i);
});

it("validates crypto pricePerCall is positive", () => {
  process.env.GATE_MODE = "test";
  expect(() =>
    resolveConfig({
      credits: { amount: 100, price: 500 },
      crypto: { address: "0x" + "a".repeat(40), pricePerCall: 0 },
    }),
  ).toThrow(/pricePerCall/i);
});

it("converts USD to smallest unit correctly", () => {
  process.env.GATE_MODE = "test";
  const config = resolveConfig({
    credits: { amount: 100, price: 500 },
    crypto: { address: "0x" + "a".repeat(40), pricePerCall: 1.0 },
  });
  expect(config.crypto!.amountSmallestUnit).toBe("1000000");
});

it("maps network shorthands to CAIP-2", () => {
  process.env.GATE_MODE = "test";
  const config = resolveConfig({
    credits: { amount: 100, price: 500 },
    crypto: {
      address: "0x" + "a".repeat(40),
      pricePerCall: 0.005,
      networks: ["base-sepolia"],
    },
  });
  expect(config.crypto!.networks).toEqual(["eip155:84532"]);
});

it("auto-generates mppSecret in test mode", () => {
  process.env.GATE_MODE = "test";
  const config = resolveConfig({
    credits: { amount: 100, price: 500 },
    crypto: { address: "0x" + "a".repeat(40), pricePerCall: 0.005 },
  });
  expect(config.crypto!.mppSecret).toBeTruthy();
  expect(config.crypto!.mppSecret.length).toBeGreaterThanOrEqual(32);
});

it("uses test facilitator URL in test mode", () => {
  process.env.GATE_MODE = "test";
  const config = resolveConfig({
    credits: { amount: 100, price: 500 },
    crypto: { address: "0x" + "a".repeat(40), pricePerCall: 0.005 },
  });
  expect(config.crypto!.facilitatorUrl).toContain("gate.test");
});
```

## Acceptance criteria

- `npx tsc --noEmit` passes
- `npm test` passes (all existing 76 tests + new config tests)
- `npm run build` succeeds
- No new entries in `dependencies` in package.json
- A config with `crypto` but no `stripe` resolves successfully in live mode
- A config with neither throws
- Crypto field on ResolvedConfig is `null` when not provided (existing behavior unchanged)
