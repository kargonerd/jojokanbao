import * as fs from 'fs';

async function main() {
  const articleContent = `
发射时间：2026年4月1日（周三）美东时间下午6:35。
发射地点：佛罗里达州肯尼迪航天中心。
运载工具：太空发射系统（SLS）火箭。
载人飞船：“猎户座”（Orion）飞船（文中亦提到名为“诚信号”）。
任务性质：为期约10天的绕月飞行任务（不登陆月球），旨在测试飞船的生命保障系统。
返回计划：预计于2026年4月10日在太平洋溅落。

宇航员名单与历史意义:
此次任务共有四名宇航员，创下了多项航天史上的“第一”：
里德·怀斯曼 (Reid Wiseman)：任务指令长。
维克多·格洛弗 (Victor Glover)：首位进入深空/绕月飞行的黑人男性。
克里斯蒂娜·科赫 (Christina Koch)：首位进入深空/绕月飞行的女性。
杰里米·汉森 (Jeremy Hansen)：来自加拿大航天局，首位参与登月任务的非美国人。

战略背景与目标:
重返月球：这是自1972年阿波罗计划结束以来，人类首次重返月球轨道，被视为21世纪的“阿波罗8号”。
国际竞争：NASA旨在月球表面建立持续存在的前哨基地，并力争在月球探索上领先于计划在2030年前登月的中国。
领导层变动：报道提到贾里德·艾萨克曼（Jared Isaacman）于2025年12月出任NASA局长后，将目标重点放在2028年底前实现再次登月。
  `.trim();

  const currentNews = {
    id: 'nyt-20260402',
    title: 'NASA阿耳忒弥斯2号发射，人类50多年后重返月球',
    content: articleContent
  };

  const simulatedSearchResults = [
    {
      id: 'apollo-11-history',
      title: '阿波罗11号登月：1969年的历史性时刻',
      content: '1969年7月20日，阿波罗11号任务成功登月，尼尔·阿姆斯特朗成为第一个踏上月球的人。这一成就标志着美国在冷战时期的太空竞赛中取得了决定性胜利。当时的计划是由白人男性主导的。'
    },
    {
      id: 'artemis-1-test',
      title: '阿尔忒弥斯1号无人绕月任务圆满成功',
      content: '2022年底，NASA成功发射了阿尔忒弥斯1号，这是太空发射系统（SLS）和猎户座飞船的首次综合飞行测试。任务为期25天，未搭载宇航员，为后续的载人飞行铺平了道路。'
    },
    {
      id: 'china-moon-2030',
      title: '中国计划在2030年前实现载人登月',
      content: '中国航天局宣布，计划在2030年前实现中国人首次登陆月球，并开展月球科学考察及相关技术试验。这一计划加剧了中美在太空探索领域的新一轮竞争。'
    }
  ];

  const candidates = simulatedSearchResults;
  const prompt = {
    model: 'claude-3-7-sonnet-20250219',
    max_tokens: 800,
    messages: [
      {
        role: 'user',
        content: `请从候选新闻中挑选最多3条，与当前新闻形成“合订本”（前后反差/观点演变/历史对照）。\n\n当前新闻：${currentNews.title}\n${currentNews.content.slice(0, 1200)}\n\n候选新闻（id|title|content）：\n${candidates
          .map((c) => `${c.id}|${c.title}|${c.content.slice(0, 500)}`)
          .join('\n')}\n\n请输出 JSON 数组，每项包含 relatedNewsId, reason, score(0-1)。只输出 JSON。`
      }
    ]
  };

  console.log('\n--- EXACT PROMPT FOR CLAUDE ---\n');
  console.log(JSON.stringify(prompt, null, 2));
  console.log('\n-------------------------------\n');
}

main().catch(console.error);
