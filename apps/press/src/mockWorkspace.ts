import type { ProofreadWorkspace, PageData } from './types/issues';

// 模拟真实 OCR 识别结果（更丰富的内容，与 PDF 页面对应）
const mockPages: PageData[] = [
  {
    pageNum: 1,
    content: `革命造反年代
上海文革运动史稿 I
李 逊著
大众图书馆 http://dztsg.info`,
    blocks: [
      { text: "革命造反年代", bbox: { x: 150, y: 400, width: 200, height: 40 } },
      { text: "上海文革运动史稿 I", bbox: { x: 150, y: 350, width: 180, height: 30 } },
      { text: "李 逊著", bbox: { x: 150, y: 300, width: 80, height: 25 } },
    ]
  },
  {
    pageNum: 2,
    content: `革命造反年代
上海文革运动史稿
（内部资料）
大众图书馆 http://dztsg.info`,
    blocks: [
      { text: "革命造反年代", bbox: { x: 100, y: 450, width: 200, height: 40 } },
      { text: "上海文革运动史稿", bbox: { x: 100, y: 400, width: 180, height: 30 } },
    ]
  },
  {
    pageNum: 3,
    content: `版权页
本书仅供内部研究参考
不得公开发行
大众图书馆 http://dztsg.info`,
    blocks: [
      { text: "版权页", bbox: { x: 150, y: 500, width: 80, height: 30 } },
      { text: "本书仅供内部研究参考", bbox: { x: 100, y: 450, width: 200, height: 25 } },
    ]
  },
  {
    pageNum: 4,
    content: `目 录
前言....................................1
第一章 文革爆发........................5
  一、五一六通知........................6
  二、北大的一张大字报..................8
  三、红卫兵运动兴起...................12
第二章 造反有理.......................15
  一、工人造反派.......................16
  二、安亭事件.........................18
  三、康平路事件.......................20
第三章 一月风暴.......................25
第四章 武斗年代.......................30
结语..................................35`,
    blocks: [
      { text: "目 录", bbox: { x: 180, y: 550, width: 60, height: 30 } },
      { text: "第一章 文革爆发", bbox: { x: 100, y: 500, width: 150, height: 25 } },
      { text: "第二章 造反有理", bbox: { x: 100, y: 400, width: 150, height: 25 } },
      { text: "第三章 一月风暴", bbox: { x: 100, y: 300, width: 150, height: 25 } },
    ]
  },
  {
    pageNum: 5,
    content: `前 言

文化大革命是中国现代史上一个极其重要的时期。上海作为中国的经济中心和工业基地，在文革中扮演了特殊的角色。

本书试图通过对上海文革历史的梳理，揭示那个特殊年代的政治运动逻辑，以及普通人在历史洪流中的命运。研究这段历史，不是为了延续仇恨，而是为了更好地理解过去、珍惜现在。

由于资料有限，本书难免有不足之处，恳请读者批评指正。

作者
二〇〇五年于上海`,
    blocks: [
      { text: "前 言", bbox: { x: 180, y: 550, width: 60, height: 30 } },
      { text: "文化大革命是中国现代史上", bbox: { x: 80, y: 500, width: 250, height: 20 } },
      { text: "一个极其重要的时期", bbox: { x: 80, y: 470, width: 180, height: 20 } },
    ]
  },
  {
    pageNum: 6,
    content: `第一章 文革爆发

1966年5月，中共中央政治局扩大会议通过了《中国共产党中央委员会通知》，即著名的"五一六通知"。这标志着文化大革命的正式开始。

通知指出："混进党里、政府里、军队里和各种文化界的资产阶级代表人物，是一批反革命的修正主义分子，一旦时机成熟，他们就会要夺取政权，由无产阶级专政变为资产阶级专政。"

这一论断为后来的大规模政治运动奠定了理论基础。`,
    blocks: [
      { text: "第一章 文革爆发", bbox: { x: 150, y: 550, width: 180, height: 35 } },
      { text: "1966年5月", bbox: { x: 80, y: 500, width: 100, height: 20 } },
      { text: "五一六通知", bbox: { x: 200, y: 450, width: 120, height: 25 } },
    ]
  },
  {
    pageNum: 7,
    content: `第一节 五一六通知

《五一六通知》是文化大革命的纲领性文件。它由毛泽东主持制定，经中央政治局扩大会议通过。

通知的核心观点是：党内存在一条反革命的修正主义路线，必须发动群众，揭露这批"睡在我们身旁的赫鲁晓夫那样的人物"。

这一提法直接将斗争矛头指向了党内高层，为后来的打倒刘少奇、邓小平等人制造了舆论准备。

通知发出后，全国各级党政机关开始传达学习，一场史无前例的政治运动就此拉开序幕。`,
    blocks: [
      { text: "第一节 五一六通知", bbox: { x: 150, y: 550, width: 180, height: 30 } },
      { text: "《五一六通知》是文化大革命的纲领性文件", bbox: { x: 80, y: 500, width: 300, height: 20 } },
    ]
  },
  {
    pageNum: 8,
    content: `第二节 北大的一张大字报

1966年5月25日，北京大学哲学系党总支书记聂元梓等七人贴出了题为《宋硕、陆平、彭珮云在文化革命中究竟干些什么？》的大字报。

这张大字报直指北京市委大学部副部长宋硕、北大校长陆平、党委副书记彭珮云，指责他们破坏文化大革命，是"反革命修正主义分子"。

大字报贴出后，在北大校园内引起轩然大波。有人支持，有人反对，双方展开了激烈的辩论。`,
    blocks: [
      { text: "第二节 北大的一张大字报", bbox: { x: 120, y: 550, width: 220, height: 30 } },
      { text: "1966年5月25日", bbox: { x: 80, y: 500, width: 130, height: 20 } },
      { text: "聂元梓", bbox: { x: 250, y: 500, width: 80, height: 20 } },
    ]
  },
];

// 填充剩余页面（9-20页）
for (let i = 9; i <= 20; i++) {
  mockPages.push({
    pageNum: i,
    content: `第${i}章内容

这是第${i}页的识别文本内容。在真实的 OCR 识别结果中，这里会显示从 PDF 页面中提取的全部文字。

文化大革命是中国历史上一个特殊的时期，研究这段历史对于理解中国现代政治发展具有重要意义。

（此处为模拟文本，实际使用时应替换为真实的 OCR 识别结果）`,
    blocks: [
      { text: `第${i}章内容`, bbox: { x: 150, y: 550, width: 150, height: 30 } },
      { text: "文化大革命", bbox: { x: 80, y: 500, width: 120, height: 25 } },
    ]
  });
}

export function getMockProofreadWorkspace(projectId: string): ProofreadWorkspace {
  void projectId;
  const workspace: ProofreadWorkspace = {
    status: 'ready',
    notice: null,
    issues: [],
    preview: {
      page: 1,
      pages: mockPages,
      totalPages: mockPages.length,
      originalPdfUrl: '/test.pdf',
      pageImages: []
    },
    block: null,
    toc: [
      { title: '封面与书名页', page: 1 },
      { title: '目录', page: 4 },
      { title: '前言', page: 5 },
      { title: '第一章 文革爆发', page: 6 },
      { title: '第二章 造反有理', page: 9 },
      { title: '第三章 一月风暴', page: 13 },
      { title: '第四章 武斗年代', page: 17 },
      { title: '结语', page: 20 },
    ]
  };
  return workspace;
}
