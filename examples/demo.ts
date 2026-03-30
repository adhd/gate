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
