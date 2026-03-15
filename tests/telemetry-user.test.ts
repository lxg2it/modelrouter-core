/**
 * Tests for per-user OTLP telemetry export.
 */

import { describe, it, expect } from 'vitest';
import { parseOtelHeaders } from '../src/telemetry-user.js';

describe('parseOtelHeaders', () => {
  it('returns empty object for undefined', () => {
    expect(parseOtelHeaders(undefined)).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(parseOtelHeaders('')).toEqual({});
  });

  it('parses single key=value pair', () => {
    expect(parseOtelHeaders('x-honeycomb-team=abc123')).toEqual({
      'x-honeycomb-team': 'abc123',
    });
  });

  it('parses multiple comma-separated pairs', () => {
    expect(parseOtelHeaders('x-api-key=abc,x-org-id=def')).toEqual({
      'x-api-key': 'abc',
      'x-org-id': 'def',
    });
  });

  it('trims whitespace around keys and values', () => {
    expect(parseOtelHeaders(' key = value , key2 = value2 ')).toEqual({
      'key': 'value',
      'key2': 'value2',
    });
  });

  it('handles values containing equals signs', () => {
    expect(parseOtelHeaders('Authorization=Bearer token==xyz')).toEqual({
      'Authorization': 'Bearer token==xyz',
    });
  });

  it('ignores malformed entries without equals', () => {
    expect(parseOtelHeaders('good=value,noequalssign,also-good=yes')).toEqual({
      'good': 'value',
      'also-good': 'yes',
    });
  });
});
