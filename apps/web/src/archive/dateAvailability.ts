const CHINA_TIME_OFFSET_MS = 8 * 60 * 60 * 1_000;

// The daily sync is scheduled for 14:00 China time, but GitHub Actions cron
// runs can be delayed by several hours. Recent runs have completed as late as
// 18:17, so 19:00 is the safe point at which today's archive is exposed.
export const RMRB_DAILY_AVAILABLE_HOUR = 19;

function formatChinaDate(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
}

export function getLatestRmrbAvailableDate(now = new Date()): string {
  const chinaNow = new Date(now.getTime() + CHINA_TIME_OFFSET_MS);
  if (chinaNow.getUTCHours() < RMRB_DAILY_AVAILABLE_HOUR) {
    chinaNow.setUTCDate(chinaNow.getUTCDate() - 1);
  }
  return formatChinaDate(chinaNow);
}

