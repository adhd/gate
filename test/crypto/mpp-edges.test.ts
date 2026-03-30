import { describe, expect, it } from "vitest";
import { verifyMppCredential, hasMppPayment } from "../../src/crypto/mpp.js";

const TEST_SECRET = "test-secret-key-that-is-at-least-32-bytes-long";

describe("verifyMppCredential edge cases", () => {
  it("rejects empty string", () => {
    const result = verifyMppCredential("", TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Not a Payment");
  });

  it("rejects Payment prefix with empty payload", () => {
    const result = verifyMppCredential("Payment ", TEST_SECRET);
    expect(result.valid).toBe(false);
    // Either "Malformed" or "Incomplete" depending on how empty string decodes
    expect(result.error).toBeTruthy();
  });

  it("rejects credential where challenge is null", () => {
    const cred = { challenge: null, source: "0xPayer", payload: {} };
    const encoded = Buffer.from(JSON.stringify(cred)).toString("base64url");
    const result = verifyMppCredential(`Payment ${encoded}`, TEST_SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Incomplete");
  });

  it("rejects credential where challenge.realm is empty string", () => {
    const cred = {
      challenge: {
        id: "some-id",
        realm: "",
        method: "tempo",
        intent: "charge",
        request: "some-request",
      },
      source: "0xPayer",
      payload: {},
    };
    const encoded = Buffer.from(JSON.stringify(cred)).toString("base64url");
    const result = verifyMppCredential(`Payment ${encoded}`, TEST_SECRET);

    // Empty realm should fail the !challenge.realm check
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Incomplete");
  });

  it("rejects credential where challenge.request is missing", () => {
    const cred = {
      challenge: {
        id: "some-id",
        realm: "example.com",
        method: "tempo",
        intent: "charge",
        // request is missing
      },
      source: "0xPayer",
      payload: {},
    };
    const encoded = Buffer.from(JSON.stringify(cred)).toString("base64url");
    const result = verifyMppCredential(`Payment ${encoded}`, TEST_SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Incomplete");
  });

  it("rejects credential with valid structure but forged HMAC id", () => {
    const cred = {
      challenge: {
        id: "forged-id-that-is-definitely-wrong",
        realm: "api.example.com",
        method: "tempo",
        intent: "charge",
        request: Buffer.from(
          JSON.stringify({ amount: "5000", currency: "USDC", recipient: "0x" }),
        ).toString("base64url"),
      },
      source: "0xAttacker",
      payload: { hash: "0xFakeTx" },
    };
    const encoded = Buffer.from(JSON.stringify(cred)).toString("base64url");
    const result = verifyMppCredential(`Payment ${encoded}`, TEST_SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("HMAC");
  });
});

describe("hasMppPayment edge cases", () => {
  it("returns false for 'Payment' without space", () => {
    expect(hasMppPayment({ authorization: "Paymentdata" })).toBe(false);
  });

  it("returns true for Payment with trailing data", () => {
    expect(hasMppPayment({ authorization: "Payment abc123" })).toBe(true);
  });

  it("is case-sensitive: 'payment ' does not match", () => {
    expect(hasMppPayment({ authorization: "payment abc123" })).toBe(false);
  });
});
