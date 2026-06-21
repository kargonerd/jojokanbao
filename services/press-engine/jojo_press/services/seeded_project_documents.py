from jojo_press.models.book import BookBlock, BookDocument, BookMeta, ImportMeta


SEEDED_PROJECT_DOCUMENTS: dict[str, BookDocument] = {
    'project-demo': BookDocument(
        book=BookMeta(
            id='book-demo',
            title='革命造反年代',
            language='chinese_cht',
            status='draft',
        ),
        toc=[],
        blocks=[
            BookBlock(
                id='heading-demo',
                type='heading',
                text='革命造反年代',
                source_page=1,
            )
        ],
        footnotes=[],
        assets=[],
        import_meta=ImportMeta(
            source_pdf='samples/demo.pdf',
            mineru_job_id='',
            model_version='pipeline',
            language='en',
            is_ocr=True,
        ),
    ),
    'project-ops-handbook': BookDocument(
        book=BookMeta(
            id='book-ops-handbook',
            title='工作手册',
            subtitle='发布工作手册',
            authors=['编校组'],
            language='chinese_cht',
            status='metadata_confirmed',
        ),
        toc=[],
        blocks=[
            BookBlock(
                id='heading-ops',
                type='heading',
                text='工作手册',
                source_page=1,
            ),
            BookBlock(
                id='paragraph-ops-1',
                type='paragraph',
                text='请先处理阻塞问题，再执行导出。',
                source_page=1,
            ),
        ],
        footnotes=[],
        assets=[
            {'id': 'cover-ops-handbook', 'role': 'cover', 'path': 'assets/ops-handbook-cover.png'},
        ],
        import_meta=ImportMeta(
            source_pdf='samples/ops-handbook.pdf',
            mineru_job_id='',
            model_version='pipeline',
            language='en',
            is_ocr=True,
        ),
    ),
}

SEEDED_QUALITY_ISSUES: dict[str, list[dict[str, str]]] = {
    'project-ops-handbook': [{'severity': 'high'}],
}
