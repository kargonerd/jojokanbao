import { cleanup, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopRoutes } from './router';

afterEach(cleanup);

describe('Desktop shell routes', () => {
  it('shows the unified module entry page', () => {
    const router = createMemoryRouter(createDesktopRoutes(), { initialEntries: ['/'] });
    render(<RouterProvider router={router} />);
    expect(screen.getByRole('heading', { name: '工作台' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '进入 Press' })).toHaveAttribute('href', '/press');
    expect(screen.getByText('Archive')).toBeInTheDocument();
    expect(screen.getAllByText('开发中')).toHaveLength(4);
  });

  it('reserves direct routes for modules that are not enabled yet', () => {
    const router = createMemoryRouter(createDesktopRoutes(), { initialEntries: ['/archive'] });
    render(<RouterProvider router={router} />);
    expect(screen.getByRole('heading', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByText('模块位置已经保留，功能尚未启用。')).toBeInTheDocument();
  });
});
