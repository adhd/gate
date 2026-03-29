import { describe, expect, it } from "vitest";
import { generateKey, parseKey, extractKeyFromRequest } from "../src/keys.js";

describe("generateKey", () => {
  it("generates a live key with correct prefix and length", () => {
    const key = generateKey("live");
    expect(key).toMatch(/^gate_live_[a-f0-9]{32}$/);
  });

  it("generates a test key with correct prefix and length", () => {
    const key = generateKey("test");
    expect(key).toMatch(/^gate_test_[a-f0-9]{32}$/);
  });

  it("generates unique keys", () => {
    const keys = new Set(
      Array.from({ length: 100 }, () => generateKey("live")),
    );
    expect(keys.size).toBe(100);
  });
});

describe("parseKey", () => {
  it("parses a live key", () => {
    const result = parseKey("gate_live_" + "a".repeat(32));
    expect(result).toEqual({ mode: "live", token: "a".repeat(32) });
  });

  it("parses a test key", () => {
    const result = parseKey("gate_test_" + "b".repeat(32));
    expect(result).toEqual({ mode: "test", token: "b".repeat(32) });
  });

  it("returns null for invalid key", () => {
    expect(parseKey("sk_live_123")).toBeNull();
    expect(parseKey("")).toBeNull();
    expect(parseKey("gate_invalid_abc")).toBeNull();
  });
});

describe("extractKeyFromRequest", () => {
  const validKey = "gate_live_" + "a".repeat(32);

  it("extracts from Authorization Bearer header", () => {
    const result = extractKeyFromRequest(
      { authorization: `Bearer ${validKey}` },
      "https://example.com/api",
    );
    expect(result).toBe(validKey);
  });

  it("extracts from X-API-Key header", () => {
    const result = extractKeyFromRequest(
      { "x-api-key": validKey },
      "https://example.com/api",
    );
    expect(result).toBe(validKey);
  });

  it("extracts from query param", () => {
    const result = extractKeyFromRequest(
      {},
      `https://example.com/api?api_key=${validKey}`,
    );
    expect(result).toBe(validKey);
  });

  it("returns null when no key present", () => {
    const result = extractKeyFromRequest(
      { accept: "application/json" },
      "https://example.com/api",
    );
    expect(result).toBeNull();
  });

  it("returns null for invalid key format in header", () => {
    const result = extractKeyFromRequest(
      { authorization: "Bearer sk_live_not_a_gate_key" },
      "https://example.com/api",
    );
    expect(result).toBeNull();
  });
});
