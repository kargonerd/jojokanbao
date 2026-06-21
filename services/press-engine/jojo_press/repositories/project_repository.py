from pathlib import Path

from jojo_press.models.project import Project


class ProjectRepository:
    def __init__(self, projects_root: Path) -> None:
        self.projects_root = projects_root

    def create(self, project: Project) -> Project:
        project_root = self.projects_root / project.project_id
        project_root.mkdir(parents=True, exist_ok=False)
        for directory_name in ('input', 'output', 'artifacts'):
            (project_root / directory_name).mkdir(exist_ok=False)
        return project
