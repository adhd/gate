#!/usr/bin/env node

/**
 * gate-pay interactive demo server.
 * Run: npx @daviejpg/gate-pay
 *
 * Boots a Hono server in test mode with colored instructions
 * and a live request log.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { gate } from "./adapters/hono.js";
import net from "node:net";

// --- ANSI colors ---
const G = "\x1b[32m"; // green
const R = "\x1b[31m"; // red
const Y = "\x1b[33m"; // yellow
const C = "\x1b[36m"; // cyan
const D = "\x1b[2m"; // dim
const B = "\x1b[1m"; // bold
const X = "\x1b[0m"; // reset

// --- Port detection ---

async function findPort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(preferred, () => {
      server.close(() => resolve(preferred));
    });
    server.on("error", () => {
      // Port in use, let the OS pick one
      const server2 = net.createServer();
      server2.listen(0, () => {
        const addr = server2.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        server2.close(() => resolve(port));
      });
      server2.on("error", () => resolve(0));
    });
  });
}

// --- Main ---

async function main() {
  // Force test mode
  process.env.GATE_MODE = "test";

  const port = await findPort(3456);
  const base = `http://localhost:${port}`;

  const app = new Hono();
  const g = gate({
    credits: { amount: 10, price: 500 },
    crypto: {
      address: "0x" + "a".repeat(40),
      pricePerCall: 0.005,
      networks: ["base-sepolia"],
    },
  });

  // --- Request logging middleware ---
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    const status = c.res.status;
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const remaining = c.res.headers.get("x-gate-credits-remaining");
    const time = new Date().toLocaleTimeString();

    let statusColor = G;
    if (status >= 400 && status < 500) statusColor = Y;
    if (status >= 500) statusColor = R;

    let line = `${D}${time}${X}  ${B}${method}${X} ${path}  ${statusColor}${status}${X}  ${D}${ms}ms${X}`;
    if (remaining !== null) {
      line += `  ${C}credits: ${remaining}${X}`;
    }
    console.log(line);
  });

  // --- Gate routes + billing ---
  app.use("/__gate/*", g.routes);
  app.use("/api/*", g);

  app.get("/api/joke", (c) =>
    c.json({
      joke: "Why do programmers prefer dark mode? Because light attracts bugs.",
    }),
  );

  app.get("/api/weather", (c) =>
    c.json({
      location: "San Francisco",
      temp: 62,
      conditions: "Foggy, as usual",
    }),
  );

  // --- Start server ---
  serve({ fetch: app.fetch, port }, () => {
    console.log("");
    console.log(`${B}${G}gate${X} demo server running on ${C}${base}${X}`);
    console.log("");
    console.log(`${D}Mode: test (no Stripe, no blockchain)${X}`);
    console.log(
      `${D}Credits: 10 per key | Price: $5.00 | Crypto: $0.005/call${X}`,
    );
    console.log("");
    console.log(`${B}Try these:${X}`);
    console.log("");
    console.log(`  ${Y}1.${X} Get a 402:`);
    console.log(`     ${D}curl ${base}/api/joke${X}`);
    console.log("");
    console.log(`  ${Y}2.${X} Get a test key:`);
    console.log(
      `     ${D}curl ${base}/__gate/success?session_id=cs_test_demo \\`,
    );
    console.log(`       -H "accept: application/json"${X}`);
    console.log("");
    console.log(`  ${Y}3.${X} Use it:`);
    console.log(`     ${D}curl ${base}/api/joke \\`);
    console.log(`       -H "Authorization: Bearer <paste key here>"${X}`);
    console.log("");
    console.log(`  ${Y}4.${X} Check remaining credits:`);
    console.log(`     ${D}curl ${base}/__gate/status \\`);
    console.log(`       -H "Authorization: Bearer <paste key here>"${X}`);
    console.log("");
    console.log(`  ${Y}5.${X} See pricing:`);
    console.log(`     ${D}curl ${base}/__gate/pricing${X}`);
    console.log("");
    console.log(`  ${Y}6.${X} Pay with crypto (x402):`);
    console.log(
      `     ${D}# First get a 402, copy the PAYMENT-REQUIRED header,${X}`,
    );
    console.log(`     ${D}# then retry with a payment-signature header.${X}`);
    console.log(`     ${D}curl -i ${base}/api/joke${X}`);
    console.log("");
    console.log(`${D}Waiting for requests...${X}`);
    console.log("");
  });
}

main().catch((err) => {
  console.error("Failed to start demo server:", err);
  process.exit(1);
});
