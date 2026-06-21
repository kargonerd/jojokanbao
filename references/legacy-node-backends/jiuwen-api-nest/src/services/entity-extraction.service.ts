import { Injectable } from '@nestjs/common';

const PERSON_HINTS = ['先生', '女士', '总统', '主席', 'CEO', '首席', '总裁', '创始人', '董事长'];
const ORG_HINTS = ['公司', '集团', '大学', '政府', '协会', '部门', '委员会', '研究院', '中心'];
const CONTRAST_HINTS = ['反转', '打脸', '翻车', '改口', '转向', '下调', '上调', '不再', '改为'];

@Injectable()
export class EntityExtractionService {
  extract(text: string) {
    const candidates = new Set<string>();
    const tokens = text
      .replace(/\s+/g, ' ')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t && t.length >= 2 && t.length <= 12);

    for (const token of tokens) {
      if (PERSON_HINTS.some((h) => token.includes(h))) candidates.add(token);
      if (ORG_HINTS.some((h) => token.includes(h))) candidates.add(token);
    }

    const hotWords = tokens.filter((t) => CONTRAST_HINTS.some((h) => t.includes(h)));
    for (const h of hotWords) candidates.add(h);

    return Array.from(candidates).slice(0, 12);
  }
}
