import { describe, it, expect } from 'vitest';
import { inboxStatusColor } from '../plan-config';

describe('inboxStatusColor', () => {
  it('maps the new "ready" status to a Ready label', () => {
    expect(inboxStatusColor('ready').label).toBe('Ready');
  });
  it('still maps active to Warming Up', () => {
    expect(inboxStatusColor('active').label).toBe('Warming Up');
  });
});
