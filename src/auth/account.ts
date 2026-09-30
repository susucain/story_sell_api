/**
 * 账号允许的字符集：中文、拉丁字母、数字、下划线、点、短横线。
 * 首字符不能是下划线、点或短横线。
 *
 * Note: `\p{Script=Han}` 需要 `u` 标志，覆盖基本区与扩展区的汉字。
 */
export const ACCOUNT_PATTERN =
  /^[\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9_.-]{2,63}$/u;

/** 与 ACCOUNT_PATTERN 对应的用户提示，供注册与登录 DTO 复用。 */
export const ACCOUNT_ERROR_MESSAGE =
  '账号仅支持 3-64 位中文、字母、数字、下划线、点或短横线，且不能以下划线、点或短横线开头';

export function normalizeAccount(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}
