import { randomBytes } from "node:crypto";

const KEY_PREFIX_LIVE = "gate_live_";
const KEY_PREFIX_TEST = "gate_test_";
const BEARER_RE = /^Bearer\s+(gate_(?:live|test)_[a-f0-9]{32})$/i;
const KEY_RE = /^gate_(?:live|test)_[a-f0-9]{32}$/;

let queryParamWarned = false;

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

/** Extract a gate API key from request headers or query params. Expects lowercase header keys. */
export function extractKeyFromRequest(
  headers: Record<string, string>,
  url: string,
): string | null {
  const auth = headers["authorization"];
  if (auth) {
    const match = auth.match(BEARER_RE);
    if (match) return match[1];
  }

  const xApiKey = headers["x-api-key"];
  if (xApiKey && KEY_RE.test(xApiKey)) {
    return xApiKey;
  }

  if (url.includes("api_key=")) {
    try {
      const parsed = new URL(url, "http://localhost");
      const param = parsed.searchParams.get("api_key");
      if (param && KEY_RE.test(param)) {
        if (!queryParamWarned) {
          console.warn(
            "[gate] API key passed in query parameter. This is insecure. Use Authorization: Bearer or X-API-Key header instead.",
          );
          queryParamWarned = true;
        }
        return param;
      }
    } catch {
      // invalid URL
    }
  }

  return null;
}
