import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import generatedNotices from "../../legal/open-source-notices.generated.json";

export interface OpenSourcePackageNotice {
  id: string;
  name: string;
  version: string;
  license: string;
  author: string;
  homepage: string;
  noticeIds: string[];
}

export interface OpenSourceLicenseData {
  schemaVersion: number;
  lockfileSha256: string;
  projectLicense: string;
  packages: OpenSourcePackageNotice[];
  notices: Record<string, { fileName: string; text: string }>;
}

const webNotices = generatedNotices as OpenSourceLicenseData;
const sourceUrl = "https://github.com/kargonerd/jojokanbao";

function packageNoticeText(item: OpenSourcePackageNotice, data: OpenSourceLicenseData): string {
  const texts = item.noticeIds
    .map((id) => data.notices[id])
    .filter((notice): notice is { fileName: string; text: string } => Boolean(notice))
    .map((notice) => `${notice.fileName}\n${"—".repeat(Math.min(notice.fileName.length, 20))}\n${notice.text}`);
  return texts.length
    ? texts.join("\n\n")
    : "该软件包未在发布目录中附带单独的许可文本，请通过上游项目地址查看完整声明。";
}

export function OpenSourceLicensesPage({
  data = webNotices,
  editionLabel = "Web 版",
}: {
  data?: OpenSourceLicenseData;
  editionLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("jojo-kanbao");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visiblePackages = useMemo(() => data.packages.filter((item) =>
    !normalizedQuery
    || item.name.toLocaleLowerCase().includes(normalizedQuery)
    || item.license.toLocaleLowerCase().includes(normalizedQuery)), [data.packages, normalizedQuery]);
  const selectedPackage = data.packages.find((item) => item.id === selectedId);
  const detailTitle = selectedPackage ? selectedPackage.name : "JOJO 看报";
  const detailVersion = selectedPackage ? selectedPackage.version : "AGPL-3.0-only";
  const detailText = selectedPackage
    ? packageNoticeText(selectedPackage, data)
    : data.projectLicense;

  return (
    <div className="h-full overflow-y-auto bg-[var(--app-canvas)] text-ink">
      <main className="mx-auto w-full max-w-[76rem] px-5 py-7 md:px-10 md:py-10">
        <header className="border-b border-rule-dark pb-5">
          <Link className="font-sans text-xs font-black text-red underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red" to="/support">
            返回关于
          </Link>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-5">
            <div>
              <h1 className="m-0 font-serif text-3xl font-black tracking-[0.08em]">开源软件许可</h1>
              <p className="mb-0 mt-3 max-w-[46rem] font-sans text-sm font-bold leading-7 text-muted">
                JOJO 看报感谢这些开源软件。此页随版本生成，可在离线状态下查看许可正文。
              </p>
            </div>
            <span className="border border-rule-dark px-3 py-2 font-sans text-xs font-black text-muted">
              {editionLabel} · {data.packages.length} 项
            </span>
          </div>
        </header>

        <section className="mt-6 border-l-4 border-red bg-paper px-5 py-4 shadow-[4px_4px_0_rgba(139,26,26,.08)]">
          <h2 className="m-0 font-serif text-lg font-black">本项目许可与源码</h2>
          <p className="mb-0 mt-2 font-sans text-sm font-bold leading-7 text-muted">
            JOJO 看报源代码以 GNU Affero General Public License v3.0 only 发布，不提供任何明示或默示担保。
          </p>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 font-sans text-sm font-black text-red">
            <button type="button" className="border-0 bg-transparent p-0 text-left text-inherit underline underline-offset-4" onClick={() => setSelectedId("jojo-kanbao")}>查看 AGPL-3.0 正文</button>
            <a href={sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">GitHub 查看源码</a>
          </div>
        </section>

        <div className="mt-7 grid items-start gap-7 md:grid-cols-[19rem_minmax(0,1fr)]">
          <section aria-labelledby="software-list-title" className="border-y border-rule-dark bg-paper">
            <div className="border-b border-rule px-4 py-4">
              <h2 id="software-list-title" className="m-0 font-serif text-lg font-black">第三方软件</h2>
              <label className="mt-3 block">
                <span className="sr-only">搜索软件或许可证</span>
                <input
                  type="search"
                  value={query}
                  placeholder="搜索软件或许可证"
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-11 w-full border border-rule-dark bg-paper px-3 font-sans text-sm text-ink outline-none focus:border-red focus:shadow-[inset_0_-2px_0_var(--color-red)]"
                />
              </label>
            </div>
            <ul className="m-0 max-h-[34rem] list-none overflow-y-auto p-0" aria-label="第三方开源软件">
              {visiblePackages.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={selectedId === item.id ? "true" : undefined}
                    onClick={() => setSelectedId(item.id)}
                    className={`block w-full border-0 border-b border-rule px-4 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-red ${selectedId === item.id ? "bg-[#f8eeee] text-red" : "bg-paper text-ink hover:bg-[var(--app-canvas)]"}`}
                  >
                    <strong className="block break-all font-sans text-sm font-black">{item.name}</strong>
                    <span className="mt-1 block font-sans text-[11px] font-bold text-muted">{item.version} · {item.license}</span>
                  </button>
                </li>
              ))}
              {!visiblePackages.length ? <li className="px-4 py-8 text-center font-sans text-sm font-bold text-muted">没有匹配的软件。</li> : null}
            </ul>
          </section>

          <article aria-live="polite" className="min-w-0 border border-rule bg-paper p-5 md:p-7">
            <header className="border-b border-red pb-4">
              <h2 className="m-0 break-all font-serif text-2xl font-black">{detailTitle}</h2>
              <p className="mb-0 mt-2 font-sans text-xs font-black text-red">{detailVersion}</p>
              {selectedPackage?.author ? <p className="mb-0 mt-2 font-sans text-xs font-bold text-muted">{selectedPackage.author}</p> : null}
              {selectedPackage?.homepage ? <a href={selectedPackage.homepage} target="_blank" rel="noreferrer" className="mt-2 inline-block break-all font-sans text-xs font-black text-red underline underline-offset-4">上游项目</a> : null}
            </header>
            <pre className="mb-0 mt-5 whitespace-pre-wrap break-words font-sans text-xs leading-6 text-ink">{detailText}</pre>
          </article>
        </div>
      </main>
    </div>
  );
}
