/**
 * Tests for ContentViolationStore — strike tracking and blocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ContentViolationStore } from '../../src/auth/violations.js';

describe('ContentViolationStore', () => {
  let db: Database.Database;
  let store: ContentViolationStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    store = new ContentViolationStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates the content_violations table', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as { name: string }[];
    expect(tables.some((t) => t.name === 'content_violations')).toBe(true);
  });

  it('returns zero strikes for a key with no violations', () => {
    const status = store.getBlockStatus('key-1');
    expect(status.blocked).toBe(false);
    expect(status.totalStrikes).toBe(0);
    expect(status.strikesInWindow).toBe(0);
  });

  it('records violations and counts them correctly', () => {
    store.record({ id: randomUUID(), keyId: 'key-1', provider: 'grok', checkType: 'SAFETY_CHECK_TYPE_CSAM' });
    store.record({ id: randomUUID(), keyId: 'key-1', provider: 'grok', checkType: 'SAFETY_CHECK_TYPE_CSAM' });

    const status = store.getBlockStatus('key-1');
    expect(status.blocked).toBe(false);
    expect(status.totalStrikes).toBe(2);
    expect(status.strikesInWindow).toBe(2);
  });

  it('blocks after 3 strikes within the 30-day window', () => {
    const keyId = 'key-3';
    store.record({ id: randomUUID(), keyId, provider: 'grok', checkType: 'CSAM' });
    store.record({ id: randomUUID(), keyId, provider: 'grok', checkType: 'CSAM' });
    store.record({ id: randomUUID(), keyId, provider: 'grok', checkType: 'CSAM' });

    const status = store.getBlockStatus(keyId);
    expect(status.blocked).toBe(true);
    expect(status.reason).toContain('24 hours');
    expect(status.blockedUntil).toBeTruthy();
    expect(status.totalStrikes).toBe(3);
  });

  it('blocks for 30 days after 6 strikes', () => {
    const keyId = 'key-6';
    for (let i = 0; i < 6; i++) {
      store.record({ id: randomUUID(), keyId, provider: 'grok', checkType: 'CSAM' });
    }

    const status = store.getBlockStatus(keyId);
    expect(status.blocked).toBe(true);
    expect(status.reason).toContain('30 days');
    expect(status.totalStrikes).toBe(6);
  });

  it('permanently blocks after 9 lifetime strikes', () => {
    const keyId = 'key-9';
    for (let i = 0; i < 9; i++) {
      store.record({ id: randomUUID(), keyId, provider: 'grok', checkType: 'CSAM' });
    }

    const status = store.getBlockStatus(keyId);
    expect(status.blocked).toBe(true);
    expect(status.reason).toContain('permanently suspended');
    expect(status.blockedUntil).toBeNull();
    expect(status.totalStrikes).toBe(9);
  });

  it('does not count strikes outside the 30-day window for blocking', () => {
    // Insert an old violation 31 days ago
    const keyId = 'key-old';
    const oldId = randomUUID();
    db.prepare(`
      INSERT INTO content_violations (id, key_id, provider, check_type, created_at)
      VALUES (?, ?, ?, ?, datetime('now', '-31 days'))
    `).run(oldId, keyId, 'grok', 'CSAM');

    // Add 2 fresh violations
    store.record({ id: randomUUID(), keyId, provider: 'grok', checkType: 'CSAM' });
    store.record({ id: randomUUID(), keyId, provider: 'grok', checkType: 'CSAM' });

    const status = store.getBlockStatus(keyId);
    expect(status.blocked).toBe(false);
    expect(status.totalStrikes).toBe(3);     // all-time
    expect(status.strikesInWindow).toBe(2);  // only 2 in window
  });

  it('builds warning messages for active strikes', () => {
    const keyId = 'key-warn';
    store.record({ id: randomUUID(), keyId, provider: 'grok', checkType: 'CSAM' });
    store.record({ id: randomUUID(), keyId, provider: 'grok', checkType: 'CSAM' });

    const status = store.getBlockStatus(keyId);
    const msg = store.buildStrikeMessage(status);
    expect(msg).toContain('strike 2 of 2');
    expect(msg).toContain('24-hour suspension');
  });

  it('returns empty string for zero strikes', () => {
    const msg = store.buildStrikeMessage(store.getBlockStatus('key-zero'));
    expect(msg).toBe('');
  });

  it('track violations per key independently', () => {
    store.record({ id: randomUUID(), keyId: 'key-a', provider: 'grok', checkType: 'CSAM' });
    store.record({ id: randomUUID(), keyId: 'key-a', provider: 'grok', checkType: 'CSAM' });
    store.record({ id: randomUUID(), keyId: 'key-a', provider: 'grok', checkType: 'CSAM' });
    store.record({ id: randomUUID(), keyId: 'key-b', provider: 'openai', checkType: 'violation' });

    const statusA = store.getBlockStatus('key-a');
    const statusB = store.getBlockStatus('key-b');
    expect(statusA.blocked).toBe(true);
    expect(statusB.blocked).toBe(false);
    expect(statusB.totalStrikes).toBe(1);
  });
});
