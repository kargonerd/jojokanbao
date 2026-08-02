// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ExportPage } from './ExportPage';
import type { ExportOption } from '../types/project';

afterEach(() => {
  cleanup();
});

describe('ExportPage', () => {
  it('shows backend-supported export options from loader-backed data', () => {
    const options: ExportOption[] = [
      { id: 'markdown', label: 'Export Markdown' },
      { id: 'html', label: 'Export HTML' },
      { id: 'epub', label: 'Export EPUB' },
      { id: 'jojo-rag', label: 'Export jojo-rag Package' }
    ];

    render(
      <MemoryRouter>
        <ExportPage options={options} />
      </MemoryRouter>
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.textContent)).toEqual([
      expect.stringContaining('Markdown'),
      expect.stringContaining('HTML'),
      expect.stringContaining('EPUB'),
      expect.stringContaining('jojo-rag')
    ]);
  });

  it('runs export and shows the generated file path', async () => {
    const options: ExportOption[] = [{ id: 'markdown', label: 'Export Markdown' }];
    const onExport = vi.fn().mockResolvedValue({ path: 'C:/exports/project-ops-handbook/markdown/book.md' });

    render(
      <MemoryRouter>
        <ExportPage options={options} onExport={onExport} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(onExport).toHaveBeenCalledWith('markdown');
    });
    expect(await screen.findByText(/C:\/exports\/project-ops-handbook\/markdown\/book\.md/)).toBeInTheDocument();
  });

  it('shows a simple instruction before the operator exports', () => {
    render(
      <MemoryRouter>
        <ExportPage options={[{ id: 'markdown', label: 'Export Markdown' }]} />
      </MemoryRouter>
    );

    expect(screen.getByRole('button').textContent).toContain('Markdown');
    expect(screen.queryByText(/C:\/exports/)).not.toBeInTheDocument();
  });
});
