export type DatedEntry = {
  data: {
    date: Date;
  };
};

const chineseDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "long",
  day: "numeric",
});

const compactDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function sortByDate<T extends DatedEntry>(entries: T[]): T[] {
  return [...entries].sort((left, right) => right.data.date.getTime() - left.data.date.getTime());
}

export function formatDate(date: Date): string {
  return chineseDate.format(date);
}

export function formatCompactDate(date: Date): string {
  return compactDate.format(date).replaceAll("/", ".");
}

export function estimateReadingTime(markdown = ""): number {
  const characterCount = markdown.replace(/\s/g, "").length;
  return Math.max(1, Math.ceil(characterCount / 450));
}
