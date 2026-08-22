export interface DailyQuote {
  text: string;
  source: string;
}

export const DAILY_QUOTES: readonly DailyQuote[] = [
  { text: "没有调查，没有发言权。", source: "毛泽东《反对本本主义》" },
  { text: "星星之火，可以燎原。", source: "毛泽东《星星之火，可以燎原》" },
  { text: "为人民服务。", source: "毛泽东《为人民服务》" },
  { text: "虚心使人进步，骄傲使人落后。", source: "毛泽东《中国共产党第八次全国代表大会开幕词》" },
  { text: "世上无难事，只要肯登攀。", source: "毛泽东《水调歌头·重上井冈山》" },
  { text: "雄关漫道真如铁，而今迈步从头越。", source: "毛泽东《忆秦娥·娄山关》" },
  { text: "不到长城非好汉，屈指行程二万。", source: "毛泽东《清平乐·六盘山》" },
  { text: "天若有情天亦老，人间正道是沧桑。", source: "毛泽东《七律·人民解放军占领南京》" },
  { text: "牢骚太盛防肠断，风物长宜放眼量。", source: "毛泽东《七律·和柳亚子先生》" },
  { text: "踏遍青山人未老，风景这边独好。", source: "毛泽东《清平乐·会昌》" },
  { text: "红军不怕远征难，万水千山只等闲。", source: "毛泽东《七律·长征》" },
  { text: "问苍茫大地，谁主沉浮？", source: "毛泽东《沁园春·长沙》" },
] as const;

function shanghaiDayNumber(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return Math.floor(Date.UTC(value("year"), value("month") - 1, value("day")) / 86_400_000);
}

export function dailyQuote(date = new Date()): DailyQuote {
  return DAILY_QUOTES[shanghaiDayNumber(date) % DAILY_QUOTES.length]!;
}
