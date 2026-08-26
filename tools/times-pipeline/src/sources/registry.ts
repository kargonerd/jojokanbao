import { africanewsSource } from "./africanews/index.js";
import { agenciaBrasilSource } from "./agencia-brasil/index.js";
import { alJazeeraSource } from "./aljazeera/index.js";
import { apSource } from "./ap/index.js";
import { bloombergSource } from "./bloomberg/index.js";
import { chinanewsSource } from "./chinanews/index.js";
import { clsSource } from "./cls/index.js";
import { cnaSource } from "./cna/index.js";
import { dwSource } from "./dw/index.js";
import { focusTaiwanSource } from "./focus-taiwan/index.js";
import { nikkeiSource } from "./nikkei/index.js";
import { peopleSource } from "./people/index.js";
import { reutersSource } from "./reuters/index.js";
import { thepaperSource } from "./thepaper/index.js";
import { xinhuaSource } from "./xinhua/index.js";
import { zaobaoSource } from "./zaobao/index.js";
import type { SourceModule } from "./contracts.js";
import type { Candidate, DiscoveryResult, DiscoveryRuntime, SourceConfig, SourcePagePolicy } from "../types.js";

const modules = new Map<string, SourceModule>([
  africanewsSource,
  agenciaBrasilSource,
  alJazeeraSource,
  apSource,
  bloombergSource,
  chinanewsSource,
  clsSource,
  cnaSource,
  dwSource,
  focusTaiwanSource,
  nikkeiSource,
  peopleSource,
  reutersSource,
  thepaperSource,
  xinhuaSource,
  zaobaoSource,
].map((module) => [module.id, module]));

export async function discoverWithSourceModule(
  source: SourceConfig,
  fetchedAt: string,
  runtime: DiscoveryRuntime = {},
): Promise<DiscoveryResult> {
  if (source.discovery.kind !== "source-adapter") throw new Error(`${source.id}: expected source-adapter discovery`);
  const endpoint = source.discovery;
  const module = modules.get(endpoint.adapter);
  if (!module) throw new Error(`${source.id}: source module is not registered: ${endpoint.adapter}`);
  let result: DiscoveryResult;
  if (endpoint.driver === "http") {
    if (!module.discoverHttp) throw new Error(`${source.id}: ${endpoint.adapter} does not support HTTP discovery`);
    result = await module.discoverHttp(source, endpoint, fetchedAt);
  } else {
    if (!runtime.browser) throw new Error(`${source.id}: browser discovery runtime is not configured`);
    if (!module.discoverBrowser) throw new Error(`${source.id}: ${endpoint.adapter} does not support browser discovery`);
    result = await module.discoverBrowser(source, endpoint, fetchedAt, runtime.browser);
  }
  if (module.page) result.pagePolicy = module.page;
  return result;
}

export function sourcePagePolicy(sourceId: string): SourcePagePolicy | undefined {
  return modules.get(sourceId)?.page;
}

export function acceptSourceCandidate(sourceId: string, candidate: Candidate): boolean {
  return modules.get(sourceId)?.accept?.(candidate) ?? true;
}

export function processSourceCandidate(sourceId: string, candidate: Candidate): Candidate {
  return modules.get(sourceId)?.process?.(candidate) ?? candidate;
}
