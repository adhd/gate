import { createHmac, timingSafeEqual } from "node:crypto";

// --- Types ---

export interface MppChallengeParams {
  /** API domain or realm identifier */
  realm: string;
  /** Payment method. Use 'tempo' for on-chain micropayments */
  method: string;
  /** Payment intent. Use 'charge' for pay-per-call */
  intent: string;
  /** Amount in smallest unit (e.g. "5000" for $0.005 USDC) */
  amount: string;
  /** Token contract address */
  currency: string;
  /** Wallet address to receive payment */
  recipient: string;
  /** Human-readable description of what the payment is for */
  description?: string;
  /** Challenge expiry in RFC 3339 format. Optional. */
  expires?: string;
}

export interface MppCredential {
  challenge: {
    id: string;
    realm: string;
    method: string;
    intent: string;
    request: string;
    expires?: string;
    digest?: string;
    opaque?: string;
  };
  /** Payer identifier (DID, wallet address, etc.) */
  source: string;
  /** Payment proof. For tempo method: { hash: "0x..." } */
  payload: Record<string, unknown>;
}

export interface MppVerifyResult {
  valid: boolean;
  payer?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

// --- Challenge generation ---

/**
 * Build the WWW-Authenticate: Payment header value.
 *
 * The challenge includes an HMAC-SHA256 `id` field computed over the
 * pipe-delimited fields: realm|method|intent|request|expires|digest|opaque.
 * This lets the server verify on the retry that the challenge wasn't
 * tampered with, without storing any server-side state.
 */
export function buildMppChallenge(
  params: MppChallengeParams,
  secretKey: string,
): string {
  const request = Buffer.from(
    JSON.stringify({
      amount: params.amount,
      currency: params.currency,
      recipient: params.recipient,
    }),
  ).toString("base64url");

  const expires = params.expires ?? "";
  const digest = "";
  const opaque = "";

  const hmacInput = [
    params.realm,
    params.method,
    params.intent,
    request,
    expires,
    digest,
    opaque,
  ].join("|");

  const id = createHmac("sha256", secretKey)
    .update(hmacInput)
    .digest("base64url");

  let header = `Payment id="${id}", realm="${params.realm}", method="${params.method}", intent="${params.intent}", request="${request}"`;
  if (expires) header += `, expires="${expires}"`;
  if (params.description) header += `, description="${params.description}"`;

  return header;
}

// --- Credential verification ---

/**
 * Verify an MPP credential from the Authorization: Payment header.
 *
 * The header value is `Payment <base64url-encoded-json>` where the JSON
 * is an MppCredential object. Verification recomputes the HMAC over the
 * challenge fields and uses constant-time comparison against the provided id.
 *
 * WARNING: This only verifies the challenge HMAC, NOT the actual on-chain
 * payment. The payload.hash field is returned but not verified against the
 * blockchain. For production use, the caller should verify the transaction
 * hash independently or use a settlement service.
 */
export function verifyMppCredential(
  authHeader: string,
  secretKey: string,
): MppVerifyResult {
  if (!authHeader.startsWith("Payment ")) {
    return { valid: false, error: "Not a Payment credential" };
  }

  let cred: MppCredential;
  try {
    const jsonStr = Buffer.from(
      authHeader.slice("Payment ".length),
      "base64url",
    ).toString("utf-8");
    cred = JSON.parse(jsonStr);
  } catch {
    return { valid: false, error: "Malformed credential" };
  }

  const { challenge } = cred;

  if (!challenge || !challenge.id || !challenge.realm || !challenge.request) {
    return { valid: false, error: "Incomplete challenge fields" };
  }

  // Recompute HMAC over the same pipe-delimited fields
  const hmacInput = [
    challenge.realm,
    challenge.method,
    challenge.intent,
    challenge.request,
    challenge.expires ?? "",
    challenge.digest ?? "",
    challenge.opaque ?? "",
  ].join("|");

  const expectedId = createHmac("sha256", secretKey)
    .update(hmacInput)
    .digest("base64url");

  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(expectedId);
  const b = Buffer.from(challenge.id);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, error: "Invalid challenge HMAC" };
  }

  // Check expiry if set
  if (challenge.expires && new Date(challenge.expires) < new Date()) {
    return { valid: false, error: "Challenge expired" };
  }

  return { valid: true, payer: cred.source, payload: cred.payload };
}

// --- Request detection ---

/** Check if a request has MPP payment credentials in the Authorization header */
export function hasMppPayment(headers: Record<string, string>): boolean {
  const auth = headers["authorization"] || "";
  return auth.startsWith("Payment ");
}
