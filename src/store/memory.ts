import type { CreditStore, KeyRecord, DecrementResult } from "../types.js";

export class MemoryStore implements CreditStore {
  private records = new Map<string, KeyRecord>();

  async get(key: string): Promise<KeyRecord | null> {
    return this.records.get(key) ?? null;
  }

  async set(key: string, record: KeyRecord): Promise<void> {
    this.records.set(key, record);
  }

  async decrement(key: string, amount = 1): Promise<DecrementResult> {
    const record = this.records.get(key);
    if (!record) return { status: "not_found" };
    if (record.credits < amount) return { status: "exhausted" };
    record.credits -= amount;
    record.lastUsedAt = new Date().toISOString();
    return { status: "ok", remaining: record.credits };
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }
}
