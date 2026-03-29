import type { CreditStore, KeyRecord } from "../types.js";

const DECREMENT_SCRIPT = `
local exists = redis.call("EXISTS", KEYS[1])
if exists == 0 then
  return nil
end

local credits = tonumber(redis.call("HGET", KEYS[1], "credits") or "-1")
if credits <= 0 then
  return nil
end

credits = credits - 1
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
    stripeConnectId: record.stripeConnectId ?? "",
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
    stripeConnectId: hash.stripeConnectId || null,
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

  async decrement(key: string): Promise<number | null> {
    const result = await this.client.eval(DECREMENT_SCRIPT, {
      keys: [this.redisKey(key)],
      arguments: [new Date().toISOString()],
    });

    if (result === null) return null;
    if (typeof result === "number") return result;

    const parsed = Number.parseInt(result, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.redisKey(key));
  }
}
