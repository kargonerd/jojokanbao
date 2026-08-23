export function parseArgs(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${name ?? "end"}`);
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

export function requiredArg(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}
