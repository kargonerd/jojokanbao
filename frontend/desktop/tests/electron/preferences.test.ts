import { describe, expect, it } from 'vitest';

import { closeBehaviors, normalizeCloseBehavior } from '../../electron/preferences.js';

describe('desktop preferences', () => {
  it('accepts the three supported close behaviors', () => {
    expect(closeBehaviors).toEqual(['ask', 'tray', 'quit']);
    expect(closeBehaviors.map(normalizeCloseBehavior)).toEqual(closeBehaviors);
  });

  it('falls back to asking when persisted data is missing or invalid', () => {
    expect(normalizeCloseBehavior(undefined)).toBe('ask');
    expect(normalizeCloseBehavior('something-else')).toBe('ask');
  });
});
