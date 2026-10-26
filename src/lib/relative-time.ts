/**
 * Codex 式会话相对时间戳：刚刚 / N 分钟 / N 小时 / N 天 / N 周；
 * 超过 30 天回退绝对日期（同年 M/D，跨年 Y/M/D）。
 * 非法输入或未来时间返回空串，调用方无需再判空。
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = now.getTime() - t;
  if (diff < 0) return "";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return days < 7 ? `${days} 天` : `${Math.floor(days / 7)} 周`;
  const d = new Date(t);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${md}`;
}
