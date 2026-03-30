import { describe, expect, it } from "vitest";
import { RedisStore, type RedisLikeClient } from "../../src/store/redis.js";
import type { KeyRecord } from "../../src/types.js";

function makeRecord(key: string, credits: number): KeyRecord {
  return {
    key,
    credits,
    stripeCustomerId: null,
    stripeSessionId: "cs_test_123",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
  };
}

class FakeRedisClient implements RedisLikeClient {
  data = new Map<string, Record<string, string>>();

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

describe("RedisStore edge cases", () => {
  it("get returns null for key with empty hash", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    // hGetAll returns {} for non-existent keys
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  it("get returns null when hash is missing key field", async () => {
    const client = new FakeRedisClient();
    client.data.set("gate:broken", { credits: "10" }); // no 'key' field
    const store = new RedisStore({ client });

    const result = await store.get("broken");
    expect(result).toBeNull();
  });

  it("get returns null when hash is missing credits field", async () => {
    const client = new FakeRedisClient();
    client.data.set("gate:broken2", { key: "broken2" }); // no 'credits' field
    const store = new RedisStore({ client });

    const result = await store.get("broken2");
    expect(result).toBeNull();
  });

  it("get returns null when credits is not a finite number", async () => {
    const client = new FakeRedisClient();
    client.data.set("gate:bad", { key: "bad", credits: "not-a-number" });
    const store = new RedisStore({ client });

    const result = await store.get("bad");
    expect(result).toBeNull();
  });

  it("deserializes null stripeCustomerId as null", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    await store.set("k1", makeRecord("k1", 5));
    const record = await store.get("k1");

    expect(record).not.toBeNull();
    expect(record!.stripeCustomerId).toBeNull();
  });

  it("deserializes null lastUsedAt as null", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    await store.set("k1", makeRecord("k1", 5));
    const record = await store.get("k1");

    expect(record!.lastUsedAt).toBeNull();
  });

  it("deserializes stripeCustomerId correctly when present", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    const record = makeRecord("k1", 5);
    record.stripeCustomerId = "cus_abc123";
    await store.set("k1", record);

    const result = await store.get("k1");
    expect(result!.stripeCustomerId).toBe("cus_abc123");
  });

  it("decrement with custom amount", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    await store.set("k1", makeRecord("k1", 20));
    const result = await store.decrement("k1", 7);

    expect(result).toEqual({ status: "ok", remaining: 13 });
  });

  it("decrement to exactly zero", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    await store.set("k1", makeRecord("k1", 1));
    const result = await store.decrement("k1");

    expect(result).toEqual({ status: "ok", remaining: 0 });
  });

  it("decrement returns exhausted when amount exceeds credits", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    await store.set("k1", makeRecord("k1", 3));
    const result = await store.decrement("k1", 10);

    expect(result).toEqual({ status: "exhausted" });
  });

  it("decrement returns not_found when eval returns null", async () => {
    const client: RedisLikeClient = {
      hGetAll: async () => ({}),
      hSet: async () => 0,
      del: async () => 0,
      eval: async () => null,
    };
    const store = new RedisStore({ client });

    const result = await store.decrement("ghost");
    expect(result).toEqual({ status: "not_found" });
  });

  it("decrement handles string return from eval", async () => {
    const client: RedisLikeClient = {
      hGetAll: async () => ({}),
      hSet: async () => 0,
      del: async () => 0,
      eval: async () => "42" as unknown as number,
    };
    const store = new RedisStore({ client });

    const result = await store.decrement("k1");
    expect(result).toEqual({ status: "ok", remaining: 42 });
  });

  it("decrement returns not_found when eval returns non-finite string", async () => {
    const client: RedisLikeClient = {
      hGetAll: async () => ({}),
      hSet: async () => 0,
      del: async () => 0,
      eval: async () => "garbage" as unknown as number,
    };
    const store = new RedisStore({ client });

    const result = await store.decrement("k1");
    expect(result).toEqual({ status: "not_found" });
  });

  it("delete removes a record", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    await store.set("k1", makeRecord("k1", 10));
    expect(await store.get("k1")).not.toBeNull();

    await store.delete("k1");
    expect(await store.get("k1")).toBeNull();
  });

  it("delete on non-existent key does not throw", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    await expect(store.delete("ghost")).resolves.toBeUndefined();
  });

  it("uses custom prefix for Redis keys", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client, prefix: "myapp:" });

    await store.set("k1", makeRecord("k1", 5));

    // The underlying Redis key should use the custom prefix
    expect(client.data.has("myapp:k1")).toBe(true);
    expect(client.data.has("gate:k1")).toBe(false);
  });

  it("uses default prefix gate: when not specified", async () => {
    const client = new FakeRedisClient();
    const store = new RedisStore({ client });

    await store.set("k1", makeRecord("k1", 5));
    expect(client.data.has("gate:k1")).toBe(true);
  });
});
