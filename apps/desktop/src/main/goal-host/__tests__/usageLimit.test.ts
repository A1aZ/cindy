import { describe, expect, it } from 'vitest';

import { classifyTurnUsageLimit } from '../usageLimit';

describe('classifyTurnUsageLimit', () => {
  it('matches Claude structured sdkError rate_limit', () => {
    expect(classifyTurnUsageLimit({ sdkError: 'rate_limit', message: 'Too many requests' })).toBe(true);
  });

  it('does NOT match Claude billing_error (out of credit, no reset → stays blocked)', () => {
    expect(classifyTurnUsageLimit({ sdkError: 'billing_error', message: 'credit balance too low' })).toBe(false);
  });

  it('matches Codex rate-limit via message text (no structured tag)', () => {
    expect(classifyTurnUsageLimit({ message: 'rate limit reached, retry later' })).toBe(true);
    expect(classifyTurnUsageLimit({ message: 'usage limit exceeded' })).toBe(true);
    expect(classifyTurnUsageLimit({ message: 'quota exhausted' })).toBe(true);
    expect(classifyTurnUsageLimit({ message: 'HTTP 429: Too Many Requests' })).toBe(true);
  });

  it('matches a preserved non-secret rate-limit status after message redaction', () => {
    expect(classifyTurnUsageLimit({ message: 'Authorization: [REDACTED]', errorStatus: 429 })).toBe(true);
    expect(classifyTurnUsageLimit({ message: 'Authorization: [REDACTED]', errorStatus: 529 })).toBe(true);
  });

  it('matches a preserved quota marker after message redaction', () => {
    expect(classifyTurnUsageLimit({ message: 'Authorization: [REDACTED]', usageLimit: true })).toBe(true);
  });

  it('does NOT match ordinary errors', () => {
    expect(classifyTurnUsageLimit({ sdkError: 'server_error', message: 'boom' })).toBe(false);
    expect(classifyTurnUsageLimit({ message: 'tool failed: file not found' })).toBe(false);
  });

  it('handles non-object / empty input', () => {
    expect(classifyTurnUsageLimit(null)).toBe(false);
    expect(classifyTurnUsageLimit(undefined)).toBe(false);
    expect(classifyTurnUsageLimit('rate limit')).toBe(false);
    expect(classifyTurnUsageLimit({})).toBe(false);
  });
});
