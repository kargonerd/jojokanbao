import re

from pydantic import BaseModel, ConfigDict, Field, StrictStr

from jojo_press.models.book import BookDocument


class ProofreadIssue(BaseModel):
    model_config = ConfigDict(extra='forbid')

    id: StrictStr = Field(min_length=1)
    kind: StrictStr = Field(min_length=1)
    severity: StrictStr = Field(min_length=1)
    block_id: StrictStr = Field(min_length=1)
    message: StrictStr = Field(min_length=1)


class IssueService:
    _POSITIVE_HEADING_LEVEL_PATTERN = re.compile(r'^(?:第\s*[一二三四五六七八九十百千零〇两\d]+\s*[章节回部篇卷集]|chapter\s+\d+)', re.IGNORECASE)

    def build(self, document: BookDocument) -> list[ProofreadIssue]:
        issues: list[ProofreadIssue] = []
        for block in document.blocks:
            if block.type != 'heading':
                continue

            if self._has_positive_level_information(block.text):
                continue

            issues.append(
                ProofreadIssue(
                    id=f'issue-{block.id}',
                    kind='heading_level_review',
                    severity='medium',
                    block_id=block.id,
                    message='这个标题可能缺少章节层级，请核对。',
                )
            )
        return issues

    def _has_positive_level_information(self, text: str) -> bool:
        return bool(self._POSITIVE_HEADING_LEVEL_PATTERN.match(text.strip()))
