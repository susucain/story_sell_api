import { ACCOUNT_PATTERN, normalizeAccount } from '../../../src/auth/account';

describe('normalizeAccount', () => {
  it('trims an account identifier without folding its case', () => {
    expect(normalizeAccount('  Creator_01  ')).toBe('Creator_01');
  });

  it('leaves Chinese characters untouched', () => {
    expect(normalizeAccount('  创作者小明  ')).toBe('创作者小明');
  });

  it('keeps non-string input unchanged for DTO validation', () => {
    expect(normalizeAccount(42)).toBe(42);
  });
});

describe('ACCOUNT_PATTERN', () => {
  it.each([
    'creator_01',
    'abc',
    '创作者小明',
    '小明2026',
    'user.name',
    'user-name',
    'Creator_01',
    'a'.repeat(20),
  ])('accepts %s', (account) => {
    expect(ACCOUNT_PATTERN.test(account)).toBe(true);
  });

  it.each([
    ['two characters', 'ab'],
    ['21 characters', 'a'.repeat(21)],
    ['whitespace', 'user name'],
    ['a leading underscore', '_user'],
    ['a leading dot', '.user'],
    ['a leading hyphen', '-user'],
    ['a slash', 'user/1'],
    ['an at sign', 'user@1'],
    ['an emoji', 'user😀'],
  ])('rejects %s', (_label, account) => {
    expect(ACCOUNT_PATTERN.test(account)).toBe(false);
  });

  it('accepts a 20-character Chinese account', () => {
    expect(ACCOUNT_PATTERN.test('创'.repeat(20))).toBe(true);
    expect(ACCOUNT_PATTERN.test('创'.repeat(21))).toBe(false);
  });
});
