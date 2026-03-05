/**
 * Unit tests for the disposable email domain filter.
 */

import { describe, it, expect } from 'vitest';
import { isDisposableEmail } from '../../src/auth/email-filter.js';

describe('isDisposableEmail', () => {
  // ─── Known disposable domains ──────────────────────────

  it('blocks mailinator.com', () => {
    expect(isDisposableEmail('test@mailinator.com')).toBe(true);
  });

  it('blocks guerrillamail.com', () => {
    expect(isDisposableEmail('x@guerrillamail.com')).toBe(true);
  });

  it('blocks guerrillamail.net', () => {
    expect(isDisposableEmail('x@guerrillamail.net')).toBe(true);
  });

  it('blocks yopmail.com', () => {
    expect(isDisposableEmail('throwaway@yopmail.com')).toBe(true);
  });

  it('blocks tempmail.com', () => {
    expect(isDisposableEmail('anon@tempmail.com')).toBe(true);
  });

  it('blocks trashmail.at', () => {
    expect(isDisposableEmail('trash@trashmail.at')).toBe(true);
  });

  it('blocks 10minutemail.com', () => {
    expect(isDisposableEmail('quick@10minutemail.com')).toBe(true);
  });

  it('blocks maildrop.cc', () => {
    expect(isDisposableEmail('drop@maildrop.cc')).toBe(true);
  });

  // ─── Subdomain matching ────────────────────────────────

  it('blocks a subdomain of mailinator.com', () => {
    expect(isDisposableEmail('user@anything.mailinator.com')).toBe(true);
  });

  it('blocks a subdomain of guerrillamail.com', () => {
    expect(isDisposableEmail('user@subdomain.guerrillamail.com')).toBe(true);
  });

  // ─── Case insensitivity ────────────────────────────────

  it('blocks uppercase MAILINATOR.COM', () => {
    expect(isDisposableEmail('test@MAILINATOR.COM')).toBe(true);
  });

  it('blocks mixed-case Yopmail.Com', () => {
    expect(isDisposableEmail('user@Yopmail.Com')).toBe(true);
  });

  // ─── Legitimate domains ────────────────────────────────

  it('allows gmail.com', () => {
    expect(isDisposableEmail('user@gmail.com')).toBe(false);
  });

  it('allows outlook.com', () => {
    expect(isDisposableEmail('user@outlook.com')).toBe(false);
  });

  it('allows a company domain', () => {
    expect(isDisposableEmail('engineer@mycompany.io')).toBe(false);
  });

  it('allows a university domain', () => {
    expect(isDisposableEmail('student@uni.edu.au')).toBe(false);
  });

  it('allows protonmail.com', () => {
    // protonmail is privacy-focused but not disposable
    expect(isDisposableEmail('private@protonmail.com')).toBe(false);
  });

  it('allows fastmail.com', () => {
    expect(isDisposableEmail('user@fastmail.com')).toBe(false);
  });

  // ─── Edge cases ────────────────────────────────────────

  it('returns false for an address with no @ symbol', () => {
    expect(isDisposableEmail('notanemail')).toBe(false);
  });
});
