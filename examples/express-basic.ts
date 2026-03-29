/**
 * Basic Express example with gate.
 *
 * Run in test mode:
 *   GATE_MODE=test npx tsx examples/express-basic.ts
 *
 * Then:
 *   curl -i http://localhost:3000/api/joke          # 402
 *   curl "http://localhost:3000/__gate/success?session_id=cs_test_1" -H "accept: application/json"
 *   curl http://localhost:3000/api/joke -H "Authorization: Bearer <key from above>"
 */
import express from "express";
import { mountGate } from "../src/adapters/express.js";

const app = express();

const billing = mountGate({
  credits: { amount: 100, price: 200 }, // 100 calls for $2.00
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },
});

// Mount gate routes BEFORE express.json() so webhook gets raw body
app.use("/__gate", billing.routes());

app.use(express.json());

// Protected route
app.use("/api", billing.middleware);
app.get("/api/joke", (_req, res) => {
  res.json({
    joke: "Why do programmers prefer dark mode? Because light attracts bugs.",
  });
});

// Health check (not gated)
app.get("/", (_req, res) => {
  res.json({ status: "ok", mode: process.env.GATE_MODE || "live" });
});

app.listen(3000, () => {
  console.log(
    `Server running on http://localhost:3000 (mode: ${process.env.GATE_MODE || "live"})`,
  );
  console.log("Try: curl -i http://localhost:3000/api/joke");
});
