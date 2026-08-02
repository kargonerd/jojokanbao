from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, StrictStr, field_validator


ProjectStage = Literal['recognition']


class ProjectNameModel(BaseModel):
    model_config = ConfigDict(extra='forbid')

    name: StrictStr = Field(min_length=1)

    @field_validator('name')
    @classmethod
    def validate_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError('name must not be blank')
        return value


class Project(ProjectNameModel):
    project_id: StrictStr = Field(min_length=1)
    current_stage: ProjectStage = 'recognition'


class CreateProjectRequest(ProjectNameModel):
    pass


class CreateProjectCommand(ProjectNameModel):
    def to_project(self) -> Project:
        return Project(project_id=uuid4().hex, name=self.name)
