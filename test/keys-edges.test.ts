import { describe, expect, it } from "vitest";
import { extractKeyFromRequest, parseKey } from "../src/keys.js";

describe("extractKeyFromRequest priority and edge cases", () => {
  const validKey = "gate_live_" + "a".repeat(32);
  const validKey2 = "gate_live_" + "b".repeat(32);

  it("Authorization header takes priority over X-API-Key", () => {
    const result = extractKeyFromRequest(
      {
        authorization: `Bearer ${validKey}`,
        "x-api-key": validKey2,
      },
      "https://example.com/api",
    );
    expect(result).toBe(validKey);
  });

  it("X-API-Key takes priority over query param", () => {
    const result = extractKeyFromRequest(
      { "x-api-key": validKey },
      `https://example.com/api?api_key=${validKey2}`,
    );
    expect(result).toBe(validKey);
  });

  it("returns null for Bearer with non-gate key format", () => {
    const result = extractKeyFromRequest(
      { authorization: "Bearer sk_test_someotherkey" },
      "https://example.com/api",
    );
    expect(result).toBeNull();
  });

  it("returns null for Bearer with gate prefix but wrong token length", () => {
    // Token is only 16 hex chars, not 32
    const result = extractKeyFromRequest(
      { authorization: "Bearer gate_live_" + "a".repeat(16) },
      "https://example.com/api",
    );
    expect(result).toBeNull();
  });

  it("returns null for X-API-Key with invalid format", () => {
    const result = extractKeyFromRequest(
      { "x-api-key": "not-a-gate-key" },
      "https://example.com/api",
    );
    expect(result).toBeNull();
  });

  it("extracts from query param even with other params present", () => {
    const result = extractKeyFromRequest(
      {},
      `https://example.com/api?foo=bar&api_key=${validKey}&baz=qux`,
    );
    expect(result).toBe(validKey);
  });

  it("returns null for api_key query param with invalid format", () => {
    const result = extractKeyFromRequest(
      {},
      "https://example.com/api?api_key=not-a-gate-key",
    );
    expect(result).toBeNull();
  });

  it("returns null for empty authorization header", () => {
    const result = extractKeyFromRequest(
      { authorization: "" },
      "https://example.com/api",
    );
    expect(result).toBeNull();
  });

  it("returns null for Authorization: Bearer with no token", () => {
    const result = extractKeyFromRequest(
      { authorization: "Bearer " },
      "https://example.com/api",
    );
    expect(result).toBeNull();
  });

  it("handles URL without query string containing api_key substring in path", () => {
    // url.includes("api_key=") is checked before parsing
    const result = extractKeyFromRequest(
      {},
      "https://example.com/api_key=something",
    );
    // This will try to parse but "something" won't match KEY_RE
    expect(result).toBeNull();
  });

  it("case insensitive: accepts uppercase hex in key", () => {
    // The regex uses case-insensitive flag for Bearer matching
    const upperKey = "gate_live_" + "A".repeat(32);
    const result = extractKeyFromRequest(
      { authorization: `Bearer ${upperKey}` },
      "https://example.com/api",
    );
    expect(result).toBe(upperKey);
  });
});

describe("parseKey edge cases", () => {
  it("returns null for gate_staging_ prefix", () => {
    expect(parseKey("gate_staging_" + "a".repeat(32))).toBeNull();
  });

  it("parses key with any token after prefix (no length validation)", () => {
    // parseKey just splits on prefix, doesn't validate token length
    const result = parseKey("gate_live_short");
    expect(result).toEqual({ mode: "live", token: "short" });
  });

  it("parses key with empty token after prefix", () => {
    const result = parseKey("gate_test_");
    expect(result).toEqual({ mode: "test", token: "" });
  });
});
