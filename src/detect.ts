import type { ClientType } from "./types.js";

const BROWSER_AGENTS = /mozilla|chrome|safari|firefox|edge|opera/i;

export function classifyClient(headers: Record<string, string>): ClientType {
  const accept = headers["accept"] || headers["Accept"] || "";
  const ua = headers["user-agent"] || headers["User-Agent"] || "";

  // If the client accepts HTML and has a browser user-agent, it's a browser
  if (accept.includes("text/html") && BROWSER_AGENTS.test(ua)) {
    return "browser";
  }

  // Everything else (curl, SDKs, agents, fetch with JSON accept)
  return "api";
}
