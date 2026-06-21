from pydantic import BaseModel, ConfigDict, Field, StrictStr

from jojo_press.models.book import BookDocument


class QualityResult(BaseModel):
    model_config = ConfigDict(extra='forbid')

    status: StrictStr = Field(min_length=1)
    checks: list[StrictStr] = Field(default_factory=list)


class QualityService:
    def evaluate(self, document: BookDocument, issues: list[dict[str, str]]) -> dict[str, str | list[str]]:
        del document
        if any(issue.get('severity') == 'high' for issue in issues):
            return QualityResult(
                status='blocked',
                checks=['Resolve high-severity issues first'],
            ).model_dump()

        return QualityResult(status='passed', checks=[]).model_dump()
