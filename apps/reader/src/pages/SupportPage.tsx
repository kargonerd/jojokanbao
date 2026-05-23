import weixinImg from "../assets/weixin.png";
import zfbImg from "../assets/zfb.png";

const downloads = [
  { name: "人民日报", links: [{ label: "OneDrive", url: "https://1drv.ms/u/s!Aj2JC1hBTlqzh8AE964HD8Mc6HAzjQ?e=QO8bmf" }, { label: "夸克网盘", url: "https://pan.quark.cn/s/e1bccf36d345" }] },
  { name: "参考消息", links: [{ label: "OneDrive", url: "https://1drv.ms/u/s!Aj2JC1hBTlqzh8AD4aXgZxiLlXtAFQ?e=BQxZoZ" }, { label: "夸克网盘", url: "https://pan.quark.cn/s/60ad563e7939" }] },
  { name: "红旗杂志", links: [{ label: "OneDrive", url: "https://1drv.ms/u/s!Aj2JC1hBTlqzh8AGcjcraz5iymoHbQ?e=nnw50i" }, { label: "夸克网盘", url: "https://pan.quark.cn/s/98470c9d1908" }] },
  { name: "人民画报", links: [{ label: "OneDrive", url: "https://1drv.ms/f/s!Aj2JC1hBTlqzkud_9htgwD5G2zOCjg?e=iJ42bO" }, { label: "夸克网盘", url: "https://pan.quark.cn/s/eeb9d114304f" }] },
  { name: "世界知识", links: [{ label: "OneDrive", url: "https://1drv.ms/f/s!Aj2JC1hBTlqzld1xkycRNnHRKXQqXw?e=eWSdrC" }, { label: "夸克网盘", url: "https://pan.quark.cn/s/68c2c60ab36b" }] },
];

export function SupportPage() {
  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="max-w-[960px] mx-auto px-5 py-7 md:px-10">
        <div className="p-8 md:p-10 border-4 border-red shadow-[inset_0_0_0_8px_var(--color-paper),inset_0_0_0_10px_var(--color-red)]">
          <Section title="反馈">
            <p className="text-ink/80 leading-8">
              网站为业余时间开发制作，如有问题或建议，可进入QQ群 <strong className="text-red">974380749</strong> 反馈，也可在B站
              <a href="https://space.bilibili.com/571556400" target="_blank" rel="noreferrer" className="font-bold">JOJO看报账号</a> 留言
            </p>
          </Section>
          <Section title="数据下载">
            <div className="space-y-3">
              {downloads.map((d) => (
                <p key={d.name} className="leading-8 text-ink/80">
                  <strong className="text-red mr-1">{d.name}：</strong>
                  {d.links.map((link, i) => (
                    <span key={link.url}>
                      <a href={link.url} target="_blank" rel="noreferrer" className="font-bold">{link.label}</a>
                      {i < d.links.length - 1 && <span className="mx-2 text-rule">|</span>}
                    </span>
                  ))}
                </p>
              ))}
            </div>
          </Section>
          <Section title="捐助">
            <p className="text-ink/80 leading-8">
              所有捐助记录在 <a href="https://docs.qq.com/sheet/DZlhxZUdmalFBUUFQ?tab=BB08J2" target="_blank" rel="noreferrer" className="font-bold">JOJO看报捐助列表</a> 中公示
            </p>
            <div className="flex flex-wrap gap-4 mt-4">
              <img src={weixinImg} alt="微信" className="max-w-[240px] border border-rule-dark" />
              <img src={zfbImg} alt="支付宝" className="max-w-[240px] border border-rule-dark" />
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7 first:mt-0">
      <h1 className="text-2xl font-bold tracking-wider text-ink border-t border-rule-dark border-b border-b-rule pt-2.5 pb-2.5 mb-4">{title}</h1>
      {children}
    </section>
  );
}
