import { useLayoutEffect } from "react";
import { DONATION_RECORDS_URL, FEEDBACK_BILIBILI_URL, PROJECT_COPYRIGHT_NOTICES } from "@jojo/content";
import { useSupportConfig } from "../../supportConfig";
import weixinImg from "../../../../packages/content/assets/support/weixin.png";
import zfbImg from "../../../../packages/content/assets/support/zfb.png";
import { rollout } from "../../rollout";
import { Link, useLocation } from "react-router-dom";
import "./support.css";
import { AnalyticsPreference } from "../../analytics/AnalyticsPreference";

const downloads = [
  { name: "人民日报", links: [
    { label: "OneDrive下载", url: "https://1drv.ms/u/s!Aj2JC1hBTlqzh8AE964HD8Mc6HAzjQ?e=QO8bmf" },
    { label: "OneDrive备用下载", url: "https://filesshare-my.sharepoint.com/:f:/g/personal/sun_filesshare_onmicrosoft_com/EsQTAcYn4WFHrqXY0YalQEIB1hin6BxrfKof5iq4JeC93w?e=h3vmfC" },
    { label: "夸克网盘下载", url: "https://pan.quark.cn/s/e1bccf36d345" },
  ]},
  { name: "参考消息", links: [
    { label: "OneDrive下载", url: "https://1drv.ms/u/s!Aj2JC1hBTlqzh8AD4aXgZxiLlXtAFQ?e=BQxZoZ" },
    { label: "夸克网盘下载", url: "https://pan.quark.cn/s/60ad563e7939" },
  ]},
  { name: "红旗杂志", links: [
    { label: "OneDrive下载", url: "https://1drv.ms/u/s!Aj2JC1hBTlqzh8AGcjcraz5iymoHbQ?e=nnw50i" },
    { label: "夸克网盘下载", url: "https://pan.quark.cn/s/98470c9d1908" },
  ]},
  { name: "人民画报", links: [
    { label: "OneDrive下载", url: "https://1drv.ms/f/s!Aj2JC1hBTlqzkud_9htgwD5G2zOCjg?e=iJ42bO" },
    { label: "夸克网盘下载", url: "https://pan.quark.cn/s/eeb9d114304f" },
  ]},
  { name: "世界知识", links: [
    { label: "OneDrive下载", url: "https://1drv.ms/f/s!Aj2JC1hBTlqzld1xkycRNnHRKXQqXw?e=eWSdrC" },
    { label: "夸克网盘下载", url: "https://pan.quark.cn/s/68c2c60ab36b" },
  ]},
];

export function SupportPage({ platformRedesign = rollout.platformRedesign }: { platformRedesign?: boolean }) {
  const { qqGroup } = useSupportConfig();
  const { hash } = useLocation();

  useLayoutEffect(() => {
    if (!hash) return;
    let sectionId: string;
    try {
      sectionId = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }
    document.getElementById(sectionId)?.scrollIntoView({ block: "start" });
  }, [hash]);

  return (
    <div className={`support-page h-full overflow-y-auto ${platformRedesign ? "bg-[var(--app-canvas)]" : "bg-paper"}`}>
      <div className="max-w-[960px] mx-auto px-5 py-7 md:px-10">
        <div className={platformRedesign
          ? "border border-rule border-t-[3px] border-t-red bg-paper p-8 shadow-[4px_4px_0_rgba(139,26,26,.08)] md:p-10"
          : "p-8 md:p-10 border-4 border-red shadow-[inset_0_0_0_8px_var(--color-paper),inset_0_0_0_10px_var(--color-red)]"
        }>

          {/* 关于与反馈 */}
          <h1 id="关于" className="mb-4 scroll-mt-20 text-2xl font-bold tracking-wider text-ink">{platformRedesign ? "关于 JOJO 看报" : "反馈"}</h1>
          <p className="text-ink/80 leading-8">
            网站为业余时间开发制作，因此较为粗糙，如果网站有任何问题，或者希望对网站提出建议，可以进入QQ群:
            <strong className="text-red"> {qqGroup} </strong> 进行反馈，也可以在B站
            <a href={FEEDBACK_BILIBILI_URL} target="_blank" rel="noreferrer" className="support-link font-bold"> JOJO看报账号</a>
            下留言或私信反馈
          </p>

          <section aria-labelledby="捐助">
            <h2 id="捐助" className="scroll-mt-20 text-2xl font-bold tracking-wider text-ink border-t border-rule mt-8 pt-5 mb-4">捐助</h2>
            <div>
              <p className="text-ink/80 leading-8">
                如果 JOJO 看报对您有帮助，欢迎自愿捐助，支持网站与 APP 的持续维护。
                所有捐助记录将在
                <a href={DONATION_RECORDS_URL} target="_blank" rel="noreferrer" className="support-link font-bold"> JOJO看报捐助列表</a>
                中公示。
              </p>
              <div className="flex flex-wrap gap-4 mt-4">
                <figure className="m-0 w-full max-w-[240px]">
                  <img src={weixinImg} alt="微信捐助收款码" width={296} height={296} className="block w-full border border-rule-dark" />
                </figure>
                <figure className="m-0 w-full max-w-[240px]">
                  <img src={zfbImg} alt="支付宝捐助收款码" width={296} height={296} className="block w-full border border-rule-dark" />
                </figure>
              </div>
            </div>
          </section>

          {/* 纪念缅怀 */}
          <h2 id="纪念缅怀" className="scroll-mt-20 text-2xl font-bold tracking-wider text-ink border-t border-rule mt-8 pt-5 mb-4">纪念缅怀</h2>
          <ul className="list-none p-0 m-0">
            <li>
              <a href="https://redstar.jojokanbao.cn" target="_blank" rel="noreferrer" className="support-link font-bold inline-flex items-center gap-1.5">
                <svg className="w-4 h-4 text-red" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.39 4.84 5.34.78-3.87 3.77.91 5.32L10 13.27l-4.77 2.51.91-5.32L2.27 6.69l5.34-.78L10 1z"/></svg>
                纪念毛主席诞辰132周年（2025）
              </a>
            </li>
          </ul>

          {/* 版权说明 */}
          <h2 id="版权说明" className="scroll-mt-20 text-2xl font-bold tracking-wider text-ink border-t border-rule mt-8 pt-5 mb-4">版权说明</h2>
          <div className="space-y-3 text-ink/80 leading-8">
            {PROJECT_COPYRIGHT_NOTICES.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </div>

          {/* 数据下载 */}
          <h2 id="数据下载" className="scroll-mt-20 text-2xl font-bold tracking-wider text-ink border-t border-rule mt-8 pt-5 mb-4">数据下载</h2>
          <div className="space-y-3">
            {downloads.map((d) => (
              <p key={d.name} className="leading-8 text-ink/80">
                <strong className="text-ink mr-1">{d.name}：</strong>
                {d.links.map((link, i) => (
                  <span key={link.url} className="inline-block">
                    <a href={link.url} target="_blank" rel="noreferrer" className="support-link font-bold">{link.label}</a>
                    {i < d.links.length - 1 && <span className="mx-2 text-rule">|</span>}
                  </span>
                ))}
              </p>
            ))}
          </div>

          <Link
            id="开源软件许可"
            to={platformRedesign ? "/support/licenses" : "/archive/support/licenses"}
            className="support-license-link mt-8 flex min-h-14 scroll-mt-20 items-center justify-between gap-5 border-t border-rule pt-5 font-bold"
          >
            <span>
              <strong className="block font-serif">开源软件许可</strong>
              <small className="mt-1 block font-sans text-xs text-muted">查看本项目与第三方软件的许可信息</small>
            </span>
            <span aria-hidden="true" className="font-serif text-red">→</span>
          </Link>
          <AnalyticsPreference />
        </div>
      </div>
    </div>
  );
}
