export const ACCOUNT_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export function normalizeAccount(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}
