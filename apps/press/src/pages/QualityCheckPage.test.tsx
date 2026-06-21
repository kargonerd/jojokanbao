// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { QualityCheckPage } from './QualityCheckPage';

afterEach(() => {
  cleanup();
});

import type { QualityStatus } from '../types/project';

describe('QualityCheckPage', () => {
  it('shows the blocking guidance for loader-backed quality data', () => {
    const quality: QualityStatus = {
      status: 'blocked',
      checks: ['Resolve high-severity issues first']
    };

    render(
      <MemoryRouter>
        <QualityCheckPage quality={quality} />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: '质量检查' })).toBeInTheDocument();
    expect(screen.getByText('识别')).toBeInTheDocument();
    expect(screen.getByText('添加书籍信息')).toBeInTheDocument();
    expect(screen.getByText('文字和格式校对')).toBeInTheDocument();
    expect(screen.getByText('导出')).toBeInTheDocument();
    expect(screen.queryByText('上传 PDF')).not.toBeInTheDocument();
    expect(screen.getByText('检查结果')).toBeInTheDocument();
    expect(screen.getByText('当前还不能导出，请先处理下面的问题。')).toBeInTheDocument();
    expect(screen.getByText('Resolve high-severity issues first')).toBeInTheDocument();
    expect(screen.getByText('全部处理完成后，再回到这里确认可以导出。')).toBeInTheDocument();
  });
});
