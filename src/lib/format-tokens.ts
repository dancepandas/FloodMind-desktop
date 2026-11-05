/**
 * 共享的 token 数量格式化：单位为 k（千），保留一位小数。
 *  62,800 → "62.8k"   53,200 → "53.2k"   1,200,000 → "1.2M"   800 → "800"
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
