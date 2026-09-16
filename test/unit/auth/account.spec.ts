import { normalizeAccount } from '../../../src/auth/account';

describe('normalizeAccount', () => {
  it('trims and lowercases an account identifier', () => {
    expect(normalizeAccount('  Creator_01  ')).toBe('creator_01');
  });

  it('keeps non-string input unchanged for DTO validation', () => {
    expect(normalizeAccount(42)).toBe(42);
  });
});
