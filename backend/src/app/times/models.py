from pydantic import BaseModel, Field


class SourceCreate(BaseModel):
    name: str
    rssUrl: str


class HighlightCreate(BaseModel):
    newsId: str
    userId: str
    startOffset: int = Field(ge=0)
    endOffset: int = Field(ge=0)
    text: str
    displayName: str | None = None


class CommentCreate(BaseModel):
    highlightId: str
    userId: str
    content: str
    displayName: str | None = None


class ScrapbookJobCreate(BaseModel):
    newsId: str


class AgentAskRequest(BaseModel):
    newsId: str
    question: str


class SearchForClaudeRequest(BaseModel):
    query: str
    limit: int = 8


class TextRequest(BaseModel):
    text: str = ""


class TimelineRequest(BaseModel):
    entity: str = ""
    articles: list[dict] = Field(default_factory=list)
