import type { ClientType } from "./types.js";

const BROWSER_AGENTS = /mozilla|chrome|safari|firefox|edge|opera/i;

/** Classify a request as browser or API client. Expects lowercase header keys. */
export function classifyClient(headers: Record<string, string>): ClientType {
  const accept = headers["accept"] || "";
  const ua = headers["user-agent"] || "";

  if (accept.includes("text/html") && BROWSER_AGENTS.test(ua)) {
    return "browser";
  }

  return "api";
}
