interface TimesSourceName {
  id: string;
  name: string;
}

const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  scmp: "南华早报",
};

export function timesSourceName(source: TimesSourceName): string {
  return SOURCE_DISPLAY_NAMES[source.id] || source.name;
}
