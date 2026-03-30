import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

describe("CLI demo server", () => {
  let proc: ChildProcess | null = null;

  afterEach(() => {
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      proc = null;
    }
  });

  it("starts a server and prints instructions", async () => {
    proc = spawn("npx", ["tsx", "src/cli.ts"], {
      env: { ...process.env, GATE_MODE: "test" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const output = await new Promise<string>((resolve, reject) => {
      let data = "";
      proc!.stdout!.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        // Wait until we see the "Waiting for requests" line
        if (data.includes("Waiting for requests")) {
          resolve(data);
        }
      });
      proc!.stderr!.on("data", () => {
        // Ignore stderr noise from tsx
      });
      proc!.on("error", reject);
      // Timeout after 10 seconds
      setTimeout(() => resolve(data), 10000);
    });

    expect(output).toContain("gate");
    expect(output).toContain("demo server running on");
    expect(output).toContain("localhost:");
    expect(output).toContain("curl");
    expect(output).toContain("/api/joke");
    expect(output).toContain("/__gate/");
    expect(output).toContain("Waiting for requests");
  }, 15000);

  it("responds to HTTP requests", async () => {
    proc = spawn("npx", ["tsx", "src/cli.ts"], {
      env: { ...process.env, GATE_MODE: "test" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for the server to start and extract the port
    const port = await new Promise<number>((resolve, reject) => {
      let data = "";
      proc!.stdout!.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        const match = data.match(/localhost:(\d+)/);
        if (match) {
          resolve(parseInt(match[1], 10));
        }
      });
      proc!.on("error", reject);
      setTimeout(() => reject(new Error("Timeout waiting for server")), 10000);
    });

    // Give it a moment to be fully ready
    await sleep(500);

    // Test: should get 402
    const res = await fetch(`http://localhost:${port}/api/joke`);
    expect(res.status).toBe(402);

    // Test: should get pricing
    const pricingRes = await fetch(`http://localhost:${port}/__gate/pricing`);
    expect(pricingRes.status).toBe(200);
    const pricing = await pricingRes.json();
    expect(pricing.credits).toBe(10);
  }, 15000);
});
