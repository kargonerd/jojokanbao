from pathlib import Path

from jojo_press.models.project import CreateProjectCommand, Project
from jojo_press.repositories.project_repository import ProjectRepository


class ProjectService:
    def __init__(self, projects_root: Path, repository: ProjectRepository | None = None) -> None:
        self.repository = repository or ProjectRepository(projects_root=projects_root)

    def create_project(self, name: str) -> Project:
        command = CreateProjectCommand(name=name)
        project = command.to_project()
        return self.repository.create(project)
