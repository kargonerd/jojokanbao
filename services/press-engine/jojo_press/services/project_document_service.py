import json
from copy import deepcopy
from pathlib import Path

from jojo_press.models.book import BookDocument
from jojo_press.services.seeded_project_documents import SEEDED_PROJECT_DOCUMENTS


class ProjectDocumentService:
    def __init__(self, projects_root: Path) -> None:
        self.projects_root = projects_root

    def list_project_ids(self) -> list[str]:
        if not self.projects_root.exists():
            return []
        return sorted(
            entry.name
            for entry in self.projects_root.iterdir()
            if entry.is_dir()
        )

    def load_book_document(self, project_id: str) -> BookDocument:
        document_path = self.projects_root / project_id / 'output' / 'book-document.json'
        try:
            return BookDocument.model_validate(json.loads(document_path.read_text(encoding='utf-8')))
        except FileNotFoundError:
            seeded_document = SEEDED_PROJECT_DOCUMENTS.get(project_id)
            if seeded_document is not None:
                return deepcopy(seeded_document)
            raise FileNotFoundError(project_id)

    def save_book_document(self, project_id: str, document: BookDocument) -> BookDocument:
        document_path = self.projects_root / project_id / 'output' / 'book-document.json'
        document_path.parent.mkdir(parents=True, exist_ok=True)
        document_path.write_text(document.model_dump_json(indent=2), encoding='utf-8')
        return document
