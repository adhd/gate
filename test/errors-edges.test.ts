import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatPrice,
  formatCredits,
  successPageHtml,
  webhookErrorStatus,
} from "../src/errors.js";

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;",
    );
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('key="value"')).toBe("key=&quot;value&quot;");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("converts numbers to string", () => {
    expect(escapeHtml(42)).toBe("42");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("handles string with no special chars", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("formatPrice", () => {
  it("formats USD with dollar sign", () => {
    expect(formatPrice(500, "usd")).toBe("$5.00");
  });

  it("formats zero cents", () => {
    expect(formatPrice(0, "usd")).toBe("$0.00");
  });

  it("formats single cent", () => {
    expect(formatPrice(1, "usd")).toBe("$0.01");
  });

  it("formats large amounts", () => {
    expect(formatPrice(999999, "usd")).toBe("$9999.99");
  });

  it("formats non-USD with uppercase currency", () => {
    expect(formatPrice(1000, "eur")).toBe("10.00 EUR");
  });

  it("formats non-USD with already uppercase currency", () => {
    expect(formatPrice(1000, "gbp")).toBe("10.00 GBP");
  });
});

describe("formatCredits", () => {
  it("formats zero", () => {
    expect(formatCredits(0)).toBe("0");
  });

  it("formats small number without commas", () => {
    expect(formatCredits(100)).toBe("100");
  });

  it("formats thousands with commas", () => {
    expect(formatCredits(1000)).toBe("1,000");
  });

  it("formats millions with commas", () => {
    expect(formatCredits(1000000)).toBe("1,000,000");
  });
});

describe("successPageHtml", () => {
  it("includes the API key in the HTML", () => {
    const html = successPageHtml("gate_test_abc123", 100);
    expect(html).toContain("gate_test_abc123");
  });

  it("includes the credit count", () => {
    const html = successPageHtml("gate_test_abc123", 100);
    expect(html).toContain("100");
  });

  it("escapes HTML in the API key", () => {
    const html = successPageHtml('<script>alert("xss")</script>', 100);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("returns valid HTML structure", () => {
    const html = successPageHtml("gate_test_abc", 50);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
    expect(html).toContain("Your API Key");
    expect(html).toContain("Authorization: Bearer");
  });
});

describe("webhookErrorStatus", () => {
  it("returns 400 for signature errors", () => {
    const err = new Error("Invalid signature verification");
    expect(webhookErrorStatus(err)).toBe(400);
  });

  it("returns 500 for other errors", () => {
    const err = new Error("Something went wrong");
    expect(webhookErrorStatus(err)).toBe(500);
  });

  it("returns 500 for non-Error values", () => {
    expect(webhookErrorStatus("string error")).toBe(500);
    expect(webhookErrorStatus(null)).toBe(500);
    expect(webhookErrorStatus(undefined)).toBe(500);
    expect(webhookErrorStatus(42)).toBe(500);
  });
});
