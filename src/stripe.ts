import Stripe from "stripe";
import type { ResolvedConfig, KeyRecord, CreditStore } from "./types.js";
import { generateKey } from "./keys.js";

const stripeClients = new Map<string, Stripe>();
const STRIPE_API_VERSION = "2025-02-24.acacia" as Stripe.LatestApiVersion;

function getStripe(config: ResolvedConfig): Stripe {
  const secretKey =
    config.mode === "test"
      ? config.stripe.secretKey || "sk_test_fake"
      : config.stripe.secretKey;

  let client = stripeClients.get(secretKey);
  if (!client) {
    client = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
    stripeClients.set(secretKey, client);
  }
  return client;
}

/** Create a Stripe Checkout session and return the URL. Called from the /buy endpoint, not per-request. */
export async function createCheckoutSession(
  config: ResolvedConfig,
  returnTo?: string,
): Promise<string> {
  if (config.mode === "test") {
    return `https://gate.test/checkout/test_session_${Date.now()}`;
  }

  const stripe = getStripe(config);
  const baseUrl = config.baseUrl!; // required in live mode

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: config.credits.currency,
          unit_amount: config.credits.price,
          product_data: {
            name: config.productName,
            description: config.productDescription || undefined,
          },
        },
        quantity: 1,
      },
    ],
    success_url: `${baseUrl}${config.routePrefix}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: returnTo || baseUrl,
    metadata: {
      gate_credits: String(config.credits.amount),
    },
  });

  if (!session.url) {
    throw new Error("Stripe returned a session without a URL");
  }

  return session.url;
}

export async function handleCheckoutSuccess(
  sessionId: string,
  config: ResolvedConfig,
  store: CreditStore,
): Promise<{ key: string; record: KeyRecord } | null> {
  // Check idempotency first (both test and live modes)
  const existing = await store.get(`session:${sessionId}`);
  if (existing) {
    return { key: existing.key, record: existing };
  }

  if (config.mode === "test") {
    const key = generateKey("test");
    const record: KeyRecord = {
      key,
      credits: config.credits.amount,
      stripeCustomerId: null,
      stripeSessionId: sessionId,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    // Write session mapping first (idempotency key)
    await store.set(`session:${sessionId}`, { ...record, key });
    await store.set(key, record);
    return { key, record };
  }

  const stripe = getStripe(config);

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    return null;
  }

  if (session.payment_status !== "paid") {
    return null;
  }

  const credits = parseInt(session.metadata?.gate_credits || "0", 10);
  if (credits <= 0) return null;

  const key = generateKey(config.mode);
  const record: KeyRecord = {
    key,
    credits,
    stripeCustomerId:
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id || null,
    stripeSessionId: sessionId,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  // Write session mapping first (idempotency key), then key record
  await store.set(`session:${sessionId}`, { ...record, key });
  await store.set(key, record);

  return { key, record };
}

export async function handleWebhook(
  body: string | Buffer,
  signature: string,
  config: ResolvedConfig,
  store: CreditStore,
): Promise<{ key: string; record: KeyRecord } | null> {
  if (config.mode === "test") return null;

  const stripe = getStripe(config);
  const event = stripe.webhooks.constructEvent(
    body,
    signature,
    config.stripe.webhookSecret,
  );

  if (event.type !== "checkout.session.completed") return null;

  const session = event.data.object as Stripe.Checkout.Session;
  return handleCheckoutSuccess(session.id, config, store);
}
