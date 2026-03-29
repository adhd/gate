import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/store/memory.js";
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

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it("get returns null for non-existent key", async () => {
    const result = await store.get("does_not_exist");
    expect(result).toBeNull();
  });

  it("set and get round-trip", async () => {
    const record = makeRecord("gate_test_abc", 50);
    await store.set("gate_test_abc", record);

    const result = await store.get("gate_test_abc");
    expect(result).toEqual(record);
  });

  it("decrement returns ok with remaining", async () => {
    await store.set("k1", makeRecord("k1", 10));

    const result = await store.decrement("k1");
    expect(result).toEqual({ status: "ok", remaining: 9 });
  });

  it("decrement returns not_found for missing key", async () => {
    const result = await store.decrement("nonexistent");
    expect(result).toEqual({ status: "not_found" });
  });

  it("decrement returns exhausted for zero-credit key", async () => {
    await store.set("k2", makeRecord("k2", 0));

    const result = await store.decrement("k2");
    expect(result).toEqual({ status: "exhausted" });
  });

  it("decrement with custom amount", async () => {
    await store.set("k3", makeRecord("k3", 20));

    const result = await store.decrement("k3", 7);
    expect(result).toEqual({ status: "ok", remaining: 13 });
  });

  it("decrement to exactly zero (1 credit, decrement by 1)", async () => {
    await store.set("k4", makeRecord("k4", 1));

    const result = await store.decrement("k4");
    expect(result).toEqual({ status: "ok", remaining: 0 });

    // Subsequent decrement should be exhausted
    const second = await store.decrement("k4");
    expect(second).toEqual({ status: "exhausted" });
  });

  it("decrement returns exhausted when amount exceeds remaining credits", async () => {
    await store.set("k5", makeRecord("k5", 3));

    const result = await store.decrement("k5", 5);
    expect(result).toEqual({ status: "exhausted" });

    // Credits should be unchanged after failed decrement
    const record = await store.get("k5");
    expect(record?.credits).toBe(3);
  });

  it("decrement updates lastUsedAt", async () => {
    await store.set("k6", makeRecord("k6", 5));

    const before = await store.get("k6");
    expect(before?.lastUsedAt).toBeNull();

    await store.decrement("k6");

    const after = await store.get("k6");
    expect(after?.lastUsedAt).not.toBeNull();
    // Should be a valid ISO string
    expect(new Date(after!.lastUsedAt!).toISOString()).toBe(after!.lastUsedAt);
  });

  it("delete removes a record", async () => {
    await store.set("k7", makeRecord("k7", 10));

    // Confirm it exists
    expect(await store.get("k7")).not.toBeNull();

    await store.delete("k7");

    expect(await store.get("k7")).toBeNull();
  });

  it("delete on non-existent key does not throw", async () => {
    await expect(store.delete("ghost")).resolves.toBeUndefined();
  });

  it("set overwrites existing record", async () => {
    await store.set("k8", makeRecord("k8", 10));
    await store.set("k8", makeRecord("k8", 99));

    const result = await store.get("k8");
    expect(result?.credits).toBe(99);
  });
});
