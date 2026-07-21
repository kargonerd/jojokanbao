from copy import deepcopy

from jojo_press.api.schemas import MetadataConfirmation
from jojo_press.models.book import BookDocument


class MetadataService:
    def extract_confirmation(self, document: BookDocument) -> MetadataConfirmation:
        return MetadataConfirmation(
            title=document.book.title,
            subtitle=document.book.subtitle,
            authors=list(document.book.authors),
            language=document.import_meta.language or document.book.language,
            cover_asset_id=self._find_cover_asset_id(document),
        )

    def update_confirmation(
        self,
        document: BookDocument,
        *,
        title: str,
        subtitle: str | None,
        authors: list[str],
        language: str,
        cover_asset_id: str | None,
    ) -> BookDocument:
        updated_document = deepcopy(document)
        updated_document.book.title = title
        updated_document.book.subtitle = subtitle
        updated_document.book.authors = [author for author in authors if author]
        updated_document.book.language = language
        updated_document.book.status = 'metadata_confirmed'
        updated_document.import_meta.language = language

        for asset in updated_document.assets:
            if not isinstance(asset, dict):
                continue
            if asset.get('role') == 'cover':
                asset['role'] = 'inline'
            if cover_asset_id is not None and asset.get('id') == cover_asset_id:
                asset['role'] = 'cover'

        return updated_document

    def _find_cover_asset_id(self, document: BookDocument) -> str | None:
        for asset in document.assets:
            if isinstance(asset, dict) and asset.get('role') == 'cover':
                asset_id = asset.get('id')
                if isinstance(asset_id, str) and asset_id:
                    return asset_id
        return None
