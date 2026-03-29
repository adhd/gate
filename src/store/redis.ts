import type { CreditStore, KeyRecord, DecrementResult } from "../types.js";

// Returns: positive number (remaining credits), -1 (not found), -2 (exhausted)
const DECREMENT_SCRIPT = `
local exists = redis.call("EXISTS", KEYS[1])
if exists == 0 then
  return -1
end

local credits = tonumber(redis.call("HGET", KEYS[1], "credits") or "0")
local cost = tonumber(ARGV[2]) or 1
if credits < cost then
  return -2
end

credits = credits - cost
redis.call("HSET", KEYS[1], "credits", tostring(credits), "lastUsedAt", ARGV[1])
return credits
`;

export interface RedisLikeClient {
  hGetAll(key: string): Promise<Record<string, string>>;
  hSet(key: string, values: Record<string, string>): Promise<number>;
  del(key: string): Promise<number>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<number | string | null>;
}

export interface RedisStoreOptions {
  client: RedisLikeClient;
  /** Redis key prefix. Default: "gate:" */
  prefix?: string;
}

function serializeRecord(record: KeyRecord): Record<string, string> {
  return {
    key: record.key,
    credits: String(record.credits),
    stripeCustomerId: record.stripeCustomerId ?? "",
    stripeSessionId: record.stripeSessionId,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt ?? "",
  };
}

function deserializeRecord(hash: Record<string, string>): KeyRecord | null {
  if (!hash.key || !hash.credits) return null;

  const credits = Number.parseInt(hash.credits, 10);
  if (!Number.isFinite(credits)) return null;

  return {
    key: hash.key,
    credits,
    stripeCustomerId: hash.stripeCustomerId || null,
    stripeSessionId: hash.stripeSessionId || "",
    createdAt: hash.createdAt || new Date(0).toISOString(),
    lastUsedAt: hash.lastUsedAt || null,
  };
}

export class RedisStore implements CreditStore {
  private readonly client: RedisLikeClient;
  private readonly prefix: string;

  constructor(options: RedisStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? "gate:";
  }

  private redisKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<KeyRecord | null> {
    const hash = await this.client.hGetAll(this.redisKey(key));
    if (!hash || Object.keys(hash).length === 0) return null;
    return deserializeRecord(hash);
  }

  async set(key: string, record: KeyRecord): Promise<void> {
    await this.client.hSet(this.redisKey(key), serializeRecord(record));
  }

  async decrement(key: string, amount = 1): Promise<DecrementResult> {
    const result = await this.client.eval(DECREMENT_SCRIPT, {
      keys: [this.redisKey(key)],
      arguments: [new Date().toISOString(), String(amount)],
    });

    if (result === -1) return { status: "not_found" };
    if (result === -2) return { status: "exhausted" };
    if (result === null) return { status: "not_found" };

    const remaining =
      typeof result === "number" ? result : Number.parseInt(result, 10);
    if (!Number.isFinite(remaining)) return { status: "not_found" };

    return { status: "ok", remaining };
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.redisKey(key));
  }
}
