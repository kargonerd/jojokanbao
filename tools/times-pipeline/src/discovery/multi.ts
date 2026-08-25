import { discoverOfficialRss } from "./rss.js";
import { discoverSitemap } from "./sitemap.js";
import { discoverSiteAdapter } from "./site-adapter.js";
import { discoverWithSourceModule, sourcePagePolicy } from "../sources/registry.js";
import type {
  Candidate,
  DiscoveryEndpoint,
  DiscoveryResult,
  DiscoveryRuntime,
  PublisherSectionRef,
  SourceConfig,
} from "../types.js";

function sectionRefs(source: SourceConfig, ids: string[]): PublisherSectionRef[] {
  const selected = new Set(ids);
  return (source.sections ?? [])
    .filter((section) => selected.has(section.id))
    .map((section) => ({ id: section.id, name: section.name }));
}

function inferredSections(source: SourceConfig, candidate: Candidate): PublisherSectionRef[] {
  const categories = new Set(candidate.publisherCategories.map((value) => value.trim().toLowerCase()).filter(Boolean));
  return (source.sections ?? []).filter((section) => {
    const prefixes = section.match?.urlPrefixes ?? [];
    const categoryNames = section.match?.publisherCategories ?? [];
    return prefixes.some((prefix) => candidate.canonicalUrl.startsWith(prefix))
      || categoryNames.some((category) => categories.has(category.trim().toLowerCase()));
  }).map((section) => ({ id: section.id, name: section.name }));
}

function annotate(source: SourceConfig, candidate: Candidate, targetSectionIds: string[]): Candidate {
  const refs = new Map<string, PublisherSectionRef>();
  for (const section of [...(candidate.publisherSections ?? []), ...sectionRefs(source, targetSectionIds), ...inferredSections(source, candidate)]) {
    refs.set(section.id, section);
  }
  return { ...candidate, publisherSections: [...refs.values()] };
}

function mergeCandidate(left: Candidate | undefined, right: Candidate): Candidate {
  if (!left) return right;
  const sections = new Map([...(left.publisherSections ?? []), ...(right.publisherSections ?? [])].map((section) => [section.id, section]));
  const categories = [...new Set([...left.publisherCategories, ...right.publisherCategories])];
  return {
    ...left,
    ...(right.discoveryBody && !left.discoveryBody ? { discoveryBody: right.discoveryBody, contentStatus: "full" as const } : {}),
    ...(right.summary && !left.summary ? { summary: right.summary } : {}),
    publisherCategories: categories,
    publisherSections: [...sections.values()],
  };
}

function isUnsupportedMedia(candidate: Candidate): boolean {
  const segments = new URL(candidate.canonicalUrl).pathname.toLowerCase().split("/").filter(Boolean);
  const categories = candidate.publisherCategories.map((category) => category.trim().toLowerCase());
  const unsupportedSegments = new Set(["gallery", "galleries", "picture", "pictures", "video", "videos", "shipin"]);
  const unsupportedCategories = new Set(["gallery", "photo gallery", "picture gallery", "video", "视频", "图集"]);
  return segments.some((segment) => unsupportedSegments.has(segment))
    || categories.some((category) => unsupportedCategories.has(category));
}

async function discoverEndpoint(
  source: SourceConfig,
  discovery: DiscoveryEndpoint,
  fetchedAt: string,
  cutoff: number,
  runtime: DiscoveryRuntime,
): Promise<DiscoveryResult> {
  const endpointSource: SourceConfig = { ...source, discovery };
  if (discovery.kind === "source-adapter") return discoverWithSourceModule(endpointSource, fetchedAt, runtime);
  if (discovery.kind === "official-rss" || discovery.kind === "official-rss-list") return discoverOfficialRss(endpointSource, fetchedAt);
  if (discovery.kind === "sitemap") return discoverSitemap(endpointSource, fetchedAt, cutoff);
  return discoverSiteAdapter(endpointSource, fetchedAt);
}

export async function discoverSource(source: SourceConfig, fetchedAt: string, cutoff: number, runtime: DiscoveryRuntime = {}): Promise<DiscoveryResult> {
  if (source.discovery.kind !== "multi") {
    const result = await discoverEndpoint(source, source.discovery, fetchedAt, cutoff, runtime);
    result.source = source;
    result.candidates = result.candidates.filter((candidate) => !isUnsupportedMedia(candidate)).map((candidate) => annotate(source, candidate, []));
    return result;
  }

  const candidates = new Map<string, Candidate>();
  const fallbackCandidateIds = new Set<string>();
  const targets: Array<Record<string, unknown>> = [];
  let pagePolicy: DiscoveryResult["pagePolicy"];
  let successfulTargets = 0;
  for (const target of source.discovery.targets) {
    try {
      const result = await discoverEndpoint(source, target.discovery, fetchedAt, cutoff, runtime);
      pagePolicy ??= result.pagePolicy;
      successfulTargets += 1;
      targets.push({ id: target.id, sectionIds: target.sectionIds, fallback: target.fallback === true, status: "ok", transport: result.transport, data: result.upstream });
      for (const candidate of result.candidates) {
        const tagged = annotate(source, candidate, target.sectionIds);
        if (target.fallback) fallbackCandidateIds.add(tagged.articleId);
        candidates.set(tagged.articleId, mergeCandidate(candidates.get(tagged.articleId), tagged));
      }
    } catch (error) {
      targets.push({
        id: target.id,
        sectionIds: target.sectionIds,
        fallback: target.fallback === true,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (successfulTargets === 0) {
    const errors = targets.map((target) => `${target.id}: ${target.error ?? "failed"}`).join("; ");
    throw new Error(`${source.id}: every discovery target failed: ${errors}`);
  }
  const values = [...candidates.values()].filter((candidate) => !isUnsupportedMedia(candidate));
  const taggedCount = values.filter((candidate) => candidate.publisherSections?.length).length;
  const selected = values.filter((candidate) => !source.sections?.length
    || candidate.publisherSections?.length
    || (taggedCount === 0 && fallbackCandidateIds.has(candidate.articleId)));
  const effectivePagePolicy = pagePolicy ?? sourcePagePolicy(source.id);
  return {
    source,
    transport: "multi",
    fetchedAt,
    upstream: { targets },
    candidates: selected,
    ...(effectivePagePolicy ? { pagePolicy: effectivePagePolicy } : {}),
  };
}
