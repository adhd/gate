import { randomBytes } from "node:crypto";

const KEY_PREFIX_LIVE = "gate_live_";
const KEY_PREFIX_TEST = "gate_test_";

export function generateKey(mode: "live" | "test"): string {
  const prefix = mode === "live" ? KEY_PREFIX_LIVE : KEY_PREFIX_TEST;
  return prefix + randomBytes(16).toString("hex");
}

export function parseKey(
  raw: string,
): { mode: "live" | "test"; token: string } | null {
  if (raw.startsWith(KEY_PREFIX_LIVE)) {
    return { mode: "live", token: raw.slice(KEY_PREFIX_LIVE.length) };
  }
  if (raw.startsWith(KEY_PREFIX_TEST)) {
    return { mode: "test", token: raw.slice(KEY_PREFIX_TEST.length) };
  }
  return null;
}

export function extractKeyFromRequest(
  headers: Record<string, string>,
  url: string,
): string | null {
  // Authorization: Bearer gate_xxx
  const auth = headers["authorization"] || headers["Authorization"];
  if (auth) {
    const match = auth.match(/^Bearer\s+(gate_(?:live|test)_[a-f0-9]{32})$/i);
    if (match) return match[1];
  }

  // X-API-Key: gate_xxx
  const xApiKey = headers["x-api-key"] || headers["X-API-Key"];
  if (xApiKey && /^gate_(?:live|test)_[a-f0-9]{32}$/.test(xApiKey)) {
    return xApiKey;
  }

  // ?api_key=gate_xxx
  try {
    const parsed = new URL(url, "http://localhost");
    const param = parsed.searchParams.get("api_key");
    if (param && /^gate_(?:live|test)_[a-f0-9]{32}$/.test(param)) {
      return param;
    }
  } catch {
    // invalid URL, skip
  }

  return null;
}
