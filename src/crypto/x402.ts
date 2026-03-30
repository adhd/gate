import type { ResolvedConfig } from "../types.js";

// USDC contract addresses by CAIP-2 network
const USDC_ADDRESSES: Record<string, string> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

// --- Types ---

export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: X402PaymentRequirements[];
}

export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface X402PaymentPayload {
  x402Version: number;
  resource?: { url: string };
  accepted: X402PaymentRequirements;
  payload: Record<string, unknown>;
}

export interface X402VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface X402SettleResult {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

// --- Header building ---

/**
 * Build the PaymentRequired object for x402 402 responses.
 * `cost` is the credit cost of this route (default 1). The base amount
 * from config is multiplied by cost to get the total.
 */
export function buildX402PaymentRequired(
  config: ResolvedConfig,
  requestUrl: string,
  cost: number,
): X402PaymentRequired {
  const crypto = config.crypto!;
  const amount = (BigInt(crypto.amountSmallestUnit) * BigInt(cost)).toString();

  return {
    x402Version: 2,
    resource: { url: requestUrl, mimeType: "application/json" },
    accepts: crypto.networks.map((network) => ({
      scheme: "exact",
      network,
      asset: crypto.asset || USDC_ADDRESSES[network] || "",
      amount,
      payTo: crypto.address,
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    })),
  };
}

/** Encode PaymentRequired to base64 for the PAYMENT-REQUIRED header */
export function encodePaymentRequired(pr: X402PaymentRequired): string {
  return Buffer.from(JSON.stringify(pr)).toString("base64");
}

/** Decode a base64-encoded payment payload (from PAYMENT-SIGNATURE or X-PAYMENT header) */
export function decodePaymentPayload(header: string): X402PaymentPayload {
  return JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
}

// --- Request detection ---

/** Check if a request has x402 payment headers */
export function hasX402Payment(headers: Record<string, string>): boolean {
  return !!(headers["payment-signature"] || headers["x-payment"]);
}

/**
 * Extract the x402 payment payload from request headers.
 * Returns null if no header found or if the payload is malformed.
 */
export function extractX402Payment(
  headers: Record<string, string>,
): X402PaymentPayload | null {
  const raw = headers["payment-signature"] || headers["x-payment"];
  if (!raw) return null;
  try {
    return decodePaymentPayload(raw);
  } catch {
    return null;
  }
}

// --- Facilitator client ---

/**
 * Verify a payment via the facilitator.
 *
 * In test mode (facilitatorUrl contains "gate.test"), returns a successful
 * verification immediately without making any HTTP call.
 */
export async function verifyX402Payment(
  facilitatorUrl: string,
  paymentPayload: X402PaymentPayload,
  paymentRequirements: X402PaymentRequirements,
): Promise<X402VerifyResult> {
  // Test mode: auto-verify
  if (facilitatorUrl.includes("gate.test")) {
    return {
      isValid: true,
      payer: (paymentPayload.payload?.payer as string) || "0xTestPayer",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${facilitatorUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements,
      }),
    });
  } catch (err) {
    return {
      isValid: false,
      invalidReason: `Facilitator unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    return {
      isValid: false,
      invalidReason: `Facilitator returned ${res.status}`,
    };
  }

  return res.json() as Promise<X402VerifyResult>;
}

/**
 * Settle a verified payment on-chain via the facilitator.
 *
 * In test mode (facilitatorUrl contains "gate.test"), returns a successful
 * settlement immediately without making any HTTP call.
 */
export async function settleX402Payment(
  facilitatorUrl: string,
  paymentPayload: X402PaymentPayload,
  paymentRequirements: X402PaymentRequirements,
): Promise<X402SettleResult> {
  // Test mode: auto-settle
  if (facilitatorUrl.includes("gate.test")) {
    return {
      success: true,
      transaction: "0xTestTxHash",
      network: paymentRequirements.network || "eip155:84532",
      payer: (paymentPayload.payload?.payer as string) || "0xTestPayer",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${facilitatorUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements,
      }),
    });
  } catch (err) {
    return {
      success: false,
      transaction: "",
      network: "",
      errorReason: `Facilitator unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    return {
      success: false,
      transaction: "",
      network: "",
      errorReason: `Facilitator returned ${res.status}`,
    };
  }

  return res.json() as Promise<X402SettleResult>;
}
