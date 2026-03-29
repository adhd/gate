import { describe, expect, it } from "vitest";
import { classifyClient } from "../src/detect.js";

describe("classifyClient", () => {
  it("classifies browser with html accept and browser user-agent", () => {
    expect(
      classifyClient({
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }),
    ).toBe("browser");
  });

  it("classifies curl as api", () => {
    expect(
      classifyClient({
        accept: "*/*",
        "user-agent": "curl/8.4.0",
      }),
    ).toBe("api");
  });

  it("classifies fetch with json accept as api", () => {
    expect(
      classifyClient({
        accept: "application/json",
        "user-agent": "node-fetch/1.0",
      }),
    ).toBe("api");
  });

  it("classifies empty headers as api", () => {
    expect(classifyClient({})).toBe("api");
  });

  it("classifies browser user-agent without html accept as api", () => {
    expect(
      classifyClient({
        accept: "application/json",
        "user-agent": "Mozilla/5.0 Chrome/120",
      }),
    ).toBe("api");
  });
});
