import type { GateResponse402, ResolvedConfig } from "./types.js";

function formatPrice(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  if (currency === "usd") return `$${amount}`;
  return `${amount} ${currency.toUpperCase()}`;
}

function formatCredits(n: number): string {
  return n.toLocaleString("en-US");
}

export function paymentRequired(
  config: ResolvedConfig,
  checkoutUrl: string,
): GateResponse402 {
  const { credits } = config;
  return {
    error: "payment_required",
    message: `This API requires payment. Purchase ${formatCredits(credits.amount)} API calls for ${formatPrice(credits.price, credits.currency)}.`,
    pricing: {
      credits: credits.amount,
      price: credits.price,
      currency: credits.currency,
      formatted: `${formatPrice(credits.price, credits.currency)} for ${formatCredits(credits.amount)} API calls`,
    },
    checkout_url: checkoutUrl,
  };
}

export function creditsExhausted(
  config: ResolvedConfig,
  checkoutUrl: string,
): GateResponse402 {
  const { credits } = config;
  return {
    error: "credits_exhausted",
    message: `Your API key has no remaining credits. Purchase ${formatCredits(credits.amount)} more calls for ${formatPrice(credits.price, credits.currency)}.`,
    pricing: {
      credits: credits.amount,
      price: credits.price,
      currency: credits.currency,
      formatted: `${formatPrice(credits.price, credits.currency)} for ${formatCredits(credits.amount)} API calls`,
    },
    checkout_url: checkoutUrl,
  };
}

export class GateConfigError extends Error {
  constructor(message: string) {
    super(`[gate] ${message}`);
    this.name = "GateConfigError";
  }
}
