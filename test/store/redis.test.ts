import { describe, expect, it } from "vitest";
import { RedisStore, type RedisLikeClient } from "../../src/store/redis.js";

class FakeRedisClient implements RedisLikeClient {
  private hashes = new Map<string, Record<string, string>>();

  async hGetAll(key: string): Promise<Record<string, string>> {
    const value = this.hashes.get(key);
    return value ? { ...value } : {};
  }

  async hSet(key: string, values: Record<string, string>): Promise<number> {
    const existing = this.hashes.get(key) ?? {};
    this.hashes.set(key, { ...existing, ...values });
    return 1;
  }

  async del(key: string): Promise<number> {
    const had = this.hashes.delete(key);
    return had ? 1 : 0;
  }

  async eval(
    _script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<number | string | null> {
    const [key] = options.keys;
    const [lastUsedAt] = options.arguments;

    const hash = this.hashes.get(key);
    if (!hash) return null;

    const credits = Number.parseInt(hash.credits ?? "-1", 10);
    if (credits <= 0) return null;

    const remaining = credits - 1;
    hash.credits = String(remaining);
    hash.lastUsedAt = lastUsedAt;
    this.hashes.set(key, hash);
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
      stripeConnectId: null,
      stripeCustomerId: "cus_123",
      stripeSessionId: "cs_test_123",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
    });

    const record = await store.get("gate_test_abc");
    expect(record).toEqual({
      key: "gate_test_abc",
      credits: 3,
      stripeConnectId: null,
      stripeCustomerId: "cus_123",
      stripeSessionId: "cs_test_123",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
    });
  });

  it("decrement returns remaining credits and updates lastUsedAt", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    await store.set("k1", {
      key: "k1",
      credits: 2,
      stripeConnectId: null,
      stripeCustomerId: null,
      stripeSessionId: "s1",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
    });

    const remaining = await store.decrement("k1");
    expect(remaining).toBe(1);

    const updated = await store.get("k1");
    expect(updated?.credits).toBe(1);
    expect(updated?.lastUsedAt).not.toBeNull();
  });

  it("decrement returns null when key is missing or exhausted", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    expect(await store.decrement("missing")).toBeNull();

    await store.set("k2", {
      key: "k2",
      credits: 0,
      stripeConnectId: null,
      stripeCustomerId: null,
      stripeSessionId: "s2",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
    });

    expect(await store.decrement("k2")).toBeNull();
  });
});
