import { africanewsSource } from "./africanews/index.js";
import { agenciaBrasilSource } from "./agencia-brasil/index.js";
import { alJazeeraSource } from "./aljazeera/index.js";
import { apSource } from "./ap/index.js";
import { axiosSource } from "./axios/index.js";
import { bloombergSource } from "./bloomberg/index.js";
import { chinanewsSource } from "./chinanews/index.js";
import { clsSource } from "./cls/index.js";
import { cnaSource } from "./cna/index.js";
import { dwSource } from "./dw/index.js";
import { focusTaiwanSource } from "./focus-taiwan/index.js";
import { ftSource } from "./ft/index.js";
import { guardianSource } from "./guardian/index.js";
import { nikkeiSource } from "./nikkei/index.js";
import { nprSource } from "./npr/index.js";
import { nytSource } from "./nyt/index.js";
import { peopleSource } from "./people/index.js";
import { reutersSource } from "./reuters/index.js";
import { scmpSource } from "./scmp/index.js";
import { thepaperSource } from "./thepaper/index.js";
import { xinhuaSource } from "./xinhua/index.js";
import { zaobaoSource } from "./zaobao/index.js";
import type { SourceModule } from "./contracts.js";
import type { ArticleBodyExtractor } from "../content/body.js";
import type { ArticleImageExtractor } from "../capture/page-images.js";
import type { CapturedHtmlPage } from "../capture/http.js";
import type {
  Candidate,
  DiscoveryResult,
  DiscoveryRuntime,
  PageAvailabilityInput,
  SourceConfig,
  SourceFetchPolicy,
  UnavailablePageReason,
} from "../types.js";

const modules = new Map<string, SourceModule>([
  africanewsSource,
  agenciaBrasilSource,
  alJazeeraSource,
  apSource,
  axiosSource,
  bloombergSource,
  chinanewsSource,
  clsSource,
  cnaSource,
  dwSource,
  focusTaiwanSource,
  ftSource,
  guardianSource,
  nikkeiSource,
  nprSource,
  nytSource,
  peopleSource,
  reutersSource,
  scmpSource,
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
  if (module.fetch) result.fetchPolicy = module.fetch;
  return result;
}

export function sourceFetchPolicy(sourceId: string): SourceFetchPolicy | undefined {
  return modules.get(sourceId)?.fetch;
}

export function sourcePageCapture(
  sourceId: string,
): ((url: string, timeoutSeconds: number) => Promise<CapturedHtmlPage | undefined>) | undefined {
  return modules.get(sourceId)?.capturePage;
}

export function sourceBodyExtractor(sourceId: string): ArticleBodyExtractor | undefined {
  return modules.get(sourceId)?.extractBody;
}

export function sourceImageExtractor(sourceId: string): ArticleImageExtractor | undefined {
  return modules.get(sourceId)?.extractImages;
}

export function sourceUnavailablePageReason(
  source: SourceConfig,
  input: PageAvailabilityInput,
): UnavailablePageReason | undefined {
  return modules.get(source.id)?.classifyUnavailable?.(input, source);
}

export function acceptSourceCandidate(sourceId: string, candidate: Candidate): boolean {
  const module = modules.get(sourceId);
  return (module?.acceptUrl?.(candidate.canonicalUrl) ?? true)
    && (module?.accept?.(candidate) ?? true);
}

export function acceptSourceUrl(sourceId: string, url: string): boolean {
  return modules.get(sourceId)?.acceptUrl?.(url) ?? true;
}

export function processSourceCandidate(sourceId: string, candidate: Candidate): Candidate {
  return modules.get(sourceId)?.process?.(candidate) ?? candidate;
}
