import { describe, expect, it } from "vitest";
import { RedisStore, type RedisLikeClient } from "../../src/store/redis.js";

class FakeRedisClient implements RedisLikeClient {
  private data = new Map<string, Record<string, string>>();

  async hGetAll(key: string) {
    return this.data.get(key) ?? {};
  }
  async hSet(key: string, values: Record<string, string>) {
    const existing = this.data.get(key) ?? {};
    this.data.set(key, { ...existing, ...values });
    return Object.keys(values).length;
  }
  async del(key: string) {
    return this.data.delete(key) ? 1 : 0;
  }
  async eval(
    _script: string,
    options: { keys: string[]; arguments: string[] },
  ) {
    const key = options.keys[0];
    const cost = Number(options.arguments[1]) || 1;
    const hash = this.data.get(key);
    if (!hash) return -1;
    const credits = Number(hash.credits ?? "0");
    if (credits < cost) return -2;
    const remaining = credits - cost;
    hash.credits = String(remaining);
    hash.lastUsedAt = options.arguments[0];
    return remaining;
  }
}

describe("RedisStore", () => {
  it("round-trips records via set/get", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client, prefix: "gate:test:" });

    await store.set("gate_test_abc", {
      key: "gate_test_abc",
      credits: 3,
      stripeCustomerId: "cus_123",
      stripeSessionId: "cs_test_123",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
    });

    const record = await store.get("gate_test_abc");
    expect(record).toEqual({
      key: "gate_test_abc",
      credits: 3,
      stripeCustomerId: "cus_123",
      stripeSessionId: "cs_test_123",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
    });
  });

  it("decrement returns remaining credits", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    await store.set("k1", {
      key: "k1",
      credits: 2,
      stripeCustomerId: null,
      stripeSessionId: "cs_test",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
    });

    const result = await store.decrement("k1");
    expect(result).toEqual({ status: "ok", remaining: 1 });
  });

  it("decrement returns not_found/exhausted for missing or empty keys", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    expect(await store.decrement("missing")).toEqual({ status: "not_found" });

    await store.set("k2", {
      key: "k2",
      credits: 0,
      stripeCustomerId: null,
      stripeSessionId: "cs_test",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
    });

    expect(await store.decrement("k2")).toEqual({ status: "exhausted" });
  });
});
