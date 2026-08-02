import re


PROJECT_ID_PATTERN = re.compile(r'^[A-Za-z0-9_-]+$')


class PdfPreviewService:
    def get_preview_image_path(self, project_id: str, page: int) -> str:
        if page < 1:
            raise ValueError('page must be greater than or equal to 1')
        if not PROJECT_ID_PATTERN.fullmatch(project_id):
            raise ValueError('project_id must contain only letters, numbers, underscores, and dashes')

        return f'projects/{project_id}/previews/page-{page}.png'
