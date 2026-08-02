// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import { MetadataConfirmPage } from './MetadataConfirmPage';

afterEach(() => {
  cleanup();
});

function renderMetadataPage(element: ReactElement) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

describe('MetadataConfirmPage', () => {
  it('renders editable controls for title, subtitle, authors, language, and cover asset', () => {
    renderMetadataPage(
      <MetadataConfirmPage
        project={{
          id: 'project-1',
          title: 'JoJo Volume 1',
          subtitle: 'Phantom Blood',
          authors: ['Hirohiko Araki'],
          language: 'ja',
          coverAssetId: 'asset-cover'
        }}
      />
    );

    expect(screen.getByRole('heading', { name: '确认书籍信息' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '项目导航' })).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(5);
    expect(document.querySelector('a[href="/press/projects/project-1/metadata?variant=a"]')).toHaveClass('project-nav__item--active');
    expect(screen.queryByText('上传 PDF')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '书名' })).toHaveValue('JoJo Volume 1');
    expect(screen.getByRole('textbox', { name: '副标题' })).toHaveValue('Phantom Blood');
    expect(screen.getByRole('textbox', { name: '作者' })).toHaveValue('Hirohiko Araki');
    expect(screen.getByRole('textbox', { name: '语言' })).toHaveValue('ja');
    expect(screen.getByRole('textbox', { name: '封面资源编号' })).toHaveValue('asset-cover');
  });

  it('keeps the confirmation action visible while metadata fields are editable', () => {
    renderMetadataPage(
      <MetadataConfirmPage
        project={{
          id: 'project-1',
          title: 'JoJo Volume 1',
          subtitle: 'Phantom Blood',
          authors: ['Hirohiko Araki'],
          language: 'ja',
          coverAssetId: 'asset-cover'
        }}
      />
    );

    const titleInput = screen.getByRole('textbox', { name: '书名' });
    fireEvent.change(titleInput, { target: { value: 'JoJo Volume 1 Revised' } });

    expect(titleInput).toHaveValue('JoJo Volume 1 Revised');
    expect(screen.getByRole('button', { name: '确认并进入文字和格式校对' })).toBeVisible();
  });

  it('updates the editable form fields when loader-backed project data changes', () => {
    const { rerender } = renderMetadataPage(
      <MetadataConfirmPage
        project={{
          id: 'project-1',
          title: 'JoJo Volume 1',
          subtitle: 'Phantom Blood',
          authors: ['Hirohiko Araki'],
          language: 'ja',
          coverAssetId: 'asset-cover'
        }}
      />
    );

    rerender(
      <MemoryRouter>
        <MetadataConfirmPage
          project={{
            id: 'project-1',
            title: 'JoJo Volume 1 Deluxe',
            subtitle: 'Battle Tendency',
            authors: ['Hirohiko Araki', 'Editorial Team'],
            language: 'en',
            coverAssetId: 'asset-deluxe'
          }}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('textbox', { name: '书名' })).toHaveValue('JoJo Volume 1 Deluxe');
    expect(screen.getByRole('textbox', { name: '副标题' })).toHaveValue('Battle Tendency');
    expect(screen.getByRole('textbox', { name: '作者' })).toHaveValue('Hirohiko Araki, Editorial Team');
    expect(screen.getByRole('textbox', { name: '语言' })).toHaveValue('en');
    expect(screen.getByRole('textbox', { name: '封面资源编号' })).toHaveValue('asset-deluxe');
  });

  it('submits metadata changes and keeps the operator moving forward', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    renderMetadataPage(
      <MetadataConfirmPage
        project={{
          id: 'project-1',
          title: 'JoJo Volume 1',
          subtitle: 'Phantom Blood',
          authors: ['Hirohiko Araki'],
          language: 'ja',
          coverAssetId: 'asset-cover'
        }}
        onConfirm={onConfirm}
      />
    );

    fireEvent.change(screen.getByRole('textbox', { name: '书名' }), { target: { value: 'JoJo Volume 1 Revised' } });
    fireEvent.change(screen.getByRole('textbox', { name: '作者' }), { target: { value: 'Hirohiko Araki, Editorial Team' } });
    fireEvent.click(screen.getByRole('button', { name: '确认并进入文字和格式校对' }));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({
        title: 'JoJo Volume 1 Revised',
        subtitle: 'Phantom Blood',
        authors: ['Hirohiko Araki', 'Editorial Team'],
        language: 'ja',
        coverAssetId: 'asset-cover'
      });
    });
  });

  it('shows a short checklist so a naive operator knows what to verify before continuing', () => {
    renderMetadataPage(
      <MetadataConfirmPage
        project={{
          id: 'project-1',
          title: 'JoJo Volume 1',
          subtitle: 'Phantom Blood',
          authors: ['Hirohiko Araki'],
          language: 'ja',
          coverAssetId: 'asset-cover'
        }}
      />
    );

    expect(screen.getByText('请检查自动识别出的书名、作者、语言和封面信息。确认无误后继续。')).toBeInTheDocument();
    expect(screen.getByText('检查书名是否正确')).toBeInTheDocument();
    expect(screen.getByText('补充或确认副标题')).toBeInTheDocument();
    expect(screen.getByText('确认作者信息')).toBeInTheDocument();
    expect(screen.getByText('确认语言')).toBeInTheDocument();
    expect(screen.getByText('确认封面资源编号')).toBeInTheDocument();
  });
});
