/**
 * Basic Hono example with gate.
 *
 * Run in test mode:
 *   GATE_MODE=test npx tsx examples/hono-basic.ts
 *
 * Then:
 *   curl -i http://localhost:3000/api/joke          # 402
 *   curl http://localhost:3000/__gate/test-key
 *   curl http://localhost:3000/api/joke -H "Authorization: Bearer <key from above>"
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { gate } from "../src/adapters/hono.js";

const app = new Hono();

const g = gate({
  credits: { amount: 100, price: 200 }, // 100 calls for $2.00
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },
});

// Gate routes (checkout, status, webhook, etc.)
app.use("/__gate/*", g.routes);

// Protected route
app.use("/api/*", g);
app.get("/api/joke", (c) =>
  c.json({
    joke: "Why do programmers prefer dark mode? Because light attracts bugs.",
  }),
);

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
