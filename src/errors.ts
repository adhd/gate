import type { GateResponse402, ResolvedConfig } from "./types.js";

function formatPrice(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  if (currency === "usd") return `$${amount}`;
  return `${amount} ${currency.toUpperCase()}`;
}

function formatCredits(n: number): string {
  return n.toLocaleString("en-US");
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
