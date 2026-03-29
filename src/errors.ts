import type { GateResponse402, ResolvedConfig } from "./types.js";

export function formatPrice(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  if (currency === "usd") return `$${amount}`;
  return `${amount} ${currency.toUpperCase()}`;
}

export function escapeHtml(str: string | number): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatCredits(n: number): string {
  return n.toLocaleString("en-US");
}

export function successPageHtml(apiKey: string, credits: number): string {
  return `<!DOCTYPE html>
<html><head><title>API Key Created</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:0 20px}
code{background:#f0f0f0;padding:4px 8px;border-radius:4px;font-size:14px;display:block;margin:12px 0;word-break:break-all}</style>
</head><body>
<h1>Your API Key</h1>
<p>Use this key to authenticate your API requests:</p>
<code>${escapeHtml(apiKey)}</code>
<p>You have <strong>${escapeHtml(credits)}</strong> credits remaining.</p>
<p>Include it as: <code>Authorization: Bearer ${escapeHtml(apiKey)}</code></p>
</body></html>`;
}

export function webhookErrorStatus(err: unknown): 400 | 500 {
  return err instanceof Error && err.message.includes("signature") ? 400 : 500;
}

function maskKey(key: string): string {
  if (key.length <= 14) return key;
  return key.slice(0, 10) + "..." + key.slice(-4);
}

export function paymentRequired(
  config: ResolvedConfig,
  purchaseUrl: string,
): GateResponse402 {
  const { credits } = config;
  return {
    error: "payment_required",
    message: `This endpoint requires an API key. Purchase ${formatCredits(credits.amount)} calls for ${formatPrice(credits.price, credits.currency)}.`,
    payment: {
      type: "checkout",
      provider: "stripe",
      purchase_url: purchaseUrl,
      pricing: {
        amount: credits.price,
        currency: credits.currency,
        credits: credits.amount,
        formatted: `${formatPrice(credits.price, credits.currency)} for ${formatCredits(credits.amount)} API calls`,
      },
    },
  };
}

export function creditsExhausted(
  config: ResolvedConfig,
  purchaseUrl: string,
  apiKey?: string,
): GateResponse402 {
  const { credits } = config;
  return {
    error: "credits_exhausted",
    message: `Your API key has no remaining credits. Purchase ${formatCredits(credits.amount)} more calls for ${formatPrice(credits.price, credits.currency)}.`,
    payment: {
      type: "checkout",
      provider: "stripe",
      purchase_url: purchaseUrl,
      pricing: {
        amount: credits.price,
        currency: credits.currency,
        credits: credits.amount,
        formatted: `${formatPrice(credits.price, credits.currency)} for ${formatCredits(credits.amount)} API calls`,
      },
    },
    ...(apiKey
      ? {
          key: {
            id: maskKey(apiKey),
            credits_remaining: 0,
          },
        }
      : {}),
  };
}

export class GateConfigError extends Error {
  constructor(message: string) {
    super(`[gate] ${message}`);
    this.name = "GateConfigError";
  }
}
