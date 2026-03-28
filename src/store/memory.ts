import type { CreditStore, KeyRecord } from "../types.js";

export class MemoryStore implements CreditStore {
  private records = new Map<string, KeyRecord>();

  async get(key: string): Promise<KeyRecord | null> {
    return this.records.get(key) ?? null;
  }

  async set(key: string, record: KeyRecord): Promise<void> {
    this.records.set(key, record);
  }

  async decrement(key: string): Promise<number | null> {
    const record = this.records.get(key);
    if (!record || record.credits <= 0) return null;
    record.credits -= 1;
    record.lastUsedAt = new Date().toISOString();
    return record.credits;
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }
}
