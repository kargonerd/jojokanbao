import { useEffect, useState } from "react";
import { FaWindows } from "react-icons/fa";
import { LuBookOpen } from "react-icons/lu";
import { SiAndroid, SiApple, SiLinux } from "react-icons/si";
import {
  formatReleaseSize,
  parseReleaseCatalog,
  releaseCatalogUrls,
  type ReleaseArtifact,
  type ReleaseCatalog,
  type ReleasePlatform,
} from "./releaseCatalog";
import "./download.css";

const RELEASE_BASE = (import.meta.env.VITE_RELEASE_CDN_BASE || "https://blacknews.jojokanbao.cn/releases").replace(/\/+$/, "");
const GITHUB_RELEASES = "https://github.com/kargonerd/jojokanbao/releases";

type ReleaseState = {
  status: "loading" | "ready" | "unavailable";
  catalogs: ReleaseCatalog[];
};

type PlatformOption = {
  key: "windows" | "macos" | "linux" | "android" | "eink" | "ios";
  label: string;
  version?: string;
  artifacts: ReleaseArtifact[];
  emptyLabel?: string;
};

function PlatformIcon({ type }: { type: PlatformOption["key"] }) {
  if (type === "windows") return <FaWindows aria-hidden="true" />;
  if (type === "linux") return <SiLinux aria-hidden="true" />;
  if (type === "android") return <SiAndroid aria-hidden="true" />;
  if (type === "eink") return <LuBookOpen aria-hidden="true" />;
  return <SiApple aria-hidden="true" />;
}

function actionLabel(option: PlatformOption, artifact: ReleaseArtifact): string {
  if (option.key === "macos") return artifact.arch === "arm64" ? "Apple 芯片" : "Intel";
  if (option.key === "linux") return artifact.format.toUpperCase();
  return `下载 ${artifact.format.toUpperCase()}`;
}

function PlatformCard({ option, loading }: { option: PlatformOption; loading: boolean }) {
  return (
    <section className={`client-platform${option.artifacts.length ? " is-available" : ""}`}>
      <div className="client-platform-icon"><PlatformIcon type={option.key} /></div>
      <h2>{option.label}</h2>
      {option.version ? <small>v{option.version}</small> : null}
      {option.artifacts.length ? <div className="client-platform-actions">
        {option.artifacts.map((artifact) => (
          <a key={artifact.id} href={artifact.url} download aria-label={`${option.label} ${actionLabel(option, artifact)}`}>
            <span>{actionLabel(option, artifact)}</span>
            <small>{formatReleaseSize(artifact.size)}</small>
          </a>
        ))}
      </div> : <span className="client-platform-unavailable">
        {loading ? "查询中" : option.emptyLabel ?? "即将提供"}
      </span>}
    </section>
  );
}

function platformOptions(catalogs: ReleaseCatalog[]): PlatformOption[] {
  const desktop = catalogs.find((catalog) => catalog.product === "desktop");
  const android = catalogs.find((catalog) => catalog.product === "mobile" && catalog.variant === "standard");
  const eink = catalogs.find((catalog) => catalog.product === "mobile" && catalog.variant === "eink");
  const desktopOption = (key: ReleasePlatform, label: string): PlatformOption => ({
    key: key as "windows" | "macos" | "linux",
    label,
    version: desktop?.version,
    artifacts: desktop?.artifacts.filter((artifact) => artifact.platform === key) ?? [],
  });
  return [
    desktopOption("windows", "Windows"),
    desktopOption("macos", "macOS"),
    desktopOption("linux", "Linux"),
    {
      key: "android",
      label: "Android",
      version: android?.version,
      artifacts: android?.artifacts ?? [],
    },
    {
      key: "eink",
      label: "墨水屏版",
      version: eink?.version,
      artifacts: eink?.artifacts ?? [],
    },
    {
      key: "ios" as const,
      label: "iPhone · iPad",
      artifacts: [],
      emptyLabel: "暂未上架",
    },
  ];
}

function PlatformGrid({ catalogs, loading }: {
  catalogs: ReleaseCatalog[];
  loading: boolean;
}) {
  return <div className="client-platform-grid">
    {platformOptions(catalogs).map((option) => (
      <PlatformCard key={option.key} option={option} loading={loading} />
    ))}
  </div>;
}

export function DownloadPage() {
  const [releaseState, setReleaseState] = useState<ReleaseState>({ status: "loading", catalogs: [] });

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "客户端下载 · JOJO 看报";
    const controller = new AbortController();
    void Promise.allSettled(releaseCatalogUrls(RELEASE_BASE).map(async (url) => {
      const response = await fetch(url, { cache: "no-cache", signal: controller.signal });
      if (!response.ok) throw new Error(`release catalog ${response.status}`);
      return parseReleaseCatalog(await response.json());
    })).then((results) => {
      if (controller.signal.aborted) return;
      const catalogs = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
      setReleaseState({ status: catalogs.length ? "ready" : "unavailable", catalogs });
    });
    return () => {
      controller.abort();
      document.title = previousTitle;
    };
  }, []);

  return (
    <main className="client-download-page" data-release-base={RELEASE_BASE}>
      <header className="client-download-header">
        <h1>下载客户端</h1>
        <p>选择设备</p>
      </header>

      <PlatformGrid catalogs={releaseState.catalogs} loading={releaseState.status === "loading"} />

      <p className="client-release-status" role="status">
        {releaseState.status === "loading" ? "正在检查可用版本" : releaseState.status === "unavailable" ? "安装包尚未发布" : "当前提供正式版"}
      </p>

      <footer className="client-download-footer">
        <a href={GITHUB_RELEASES} target="_blank" rel="noreferrer">版本记录</a>
        <span aria-hidden="true">·</span>
        <a href="https://github.com/kargonerd/jojokanbao" target="_blank" rel="noreferrer">源代码</a>
      </footer>
    </main>
  );
}
