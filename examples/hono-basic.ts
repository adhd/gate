/**
 * Basic Hono example with gate.
 *
 * Run in test mode:
 *   GATE_MODE=test npx tsx examples/hono-basic.ts
 *
 * Then:
 *   curl -i http://localhost:3000/api/joke          # 402
 *   curl "http://localhost:3000/__gate/success?session_id=cs_test_1" -H "accept: application/json"
 *   curl http://localhost:3000/api/joke -H "Authorization: Bearer <key from above>"
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { mountGate } from "../src/adapters/hono.js";

const app = new Hono();

const billing = mountGate({
  credits: { amount: 100, price: 200 }, // 100 calls for $2.00
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },
});

// Protected route
app.use("/api/*", billing.middleware);
app.get("/api/joke", (c) =>
  c.json({
    joke: "Why do programmers prefer dark mode? Because light attracts bugs.",
  }),
);

// Gate routes (checkout success + webhook)
const gateRoutes = new Hono();
billing.routes(gateRoutes);
app.route("/__gate", gateRoutes);

// Health check (not gated)
app.get("/", (c) =>
  c.json({ status: "ok", mode: process.env.GATE_MODE || "live" }),
);

serve({ fetch: app.fetch, port: 3000 }, () => {
  console.log(
    `Server running on http://localhost:3000 (mode: ${process.env.GATE_MODE || "live"})`,
  );
  console.log("Try: curl -i http://localhost:3000/api/joke");
});
