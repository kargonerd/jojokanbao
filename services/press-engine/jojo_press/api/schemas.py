from pydantic import BaseModel, ConfigDict, Field


class StrictSchema(BaseModel):
    model_config = ConfigDict(extra='forbid', populate_by_name=True)


class MetadataConfirmation(StrictSchema):
    title: str = Field(min_length=1)
    subtitle: str | None = None
    authors: list[str] = Field(default_factory=list)
    language: str = Field(min_length=1)
    cover_asset_id: str | None = Field(default=None, alias='coverAssetId')


class MetadataConfirmationUpdate(StrictSchema):
    title: str = Field(min_length=1)
    subtitle: str | None = None
    authors: list[str] = Field(default_factory=list)
    language: str = Field(min_length=1)
    cover_asset_id: str | None = Field(default=None, alias='coverAssetId')
