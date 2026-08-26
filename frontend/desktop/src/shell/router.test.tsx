import { cleanup, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopRoutes } from './router';

afterEach(cleanup);

describe('Desktop shell routes', () => {
  it('opens the new reading workspace and exposes every working module', async () => {
    const router = createMemoryRouter(createDesktopRoutes(), { initialEntries: ['/'] });
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('heading', { name: '今天读什么？' })).toBeInTheDocument();
    const navigation = screen.getByRole('navigation', { name: '主导航' });
    expect(navigation.querySelector('a[href="/library"]')).toHaveTextContent('资料库');
    expect(navigation.querySelector('a[href="/search"]')).toHaveTextContent('搜索');
    expect(navigation.querySelector('a[href="/support"]')).toHaveTextContent('关于');
    expect(navigation.querySelector('a[href="/rag"]')).toBeNull();
    expect(navigation.querySelector('a[href="/settings"]')).toBeNull();
    expect(screen.getByRole('link', { name: '设置' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: '设置' }).querySelector('svg')).toHaveAttribute('data-icon', 'adjustments');
    expect(navigation).not.toHaveTextContent(/书刊制作|Press|JOJO Times|时事/i);
    expect(screen.getByRole('heading', { name: '继续阅读' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '我的书架' })).toHaveAttribute('href', '/bookshelf');
  });

  it('opens the bookshelf as a separate desktop page', () => {
    const router = createMemoryRouter(createDesktopRoutes(), { initialEntries: ['/bookshelf'] });
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('heading', { name: '书架' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '我的书架' })).not.toBeInTheDocument();
  });

  it('reuses the Web About page and navigation entry', () => {
    const router = createMemoryRouter(createDesktopRoutes(), { initialEntries: ['/support'] });
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('link', { name: '关于' })).toHaveClass('is-active');
    expect(screen.getByRole('heading', { name: '关于 JOJO 看报' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '数据下载' })).toBeInTheDocument();
  });

  it('exposes desktop preferences as a normal settings page', () => {
    const router = createMemoryRouter(createDesktopRoutes(), { initialEntries: ['/settings'] });
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '关闭窗口时' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '每次询问' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '最小化到系统托盘' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '直接退出应用' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '开机时启动' })).toBeInTheDocument();
  });

  it('redirects the archive root to the shared periodical library', async () => {
    const router = createMemoryRouter(createDesktopRoutes(), { initialEntries: ['/archive'] });
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('button', { name: '报刊' })).toBeInTheDocument();
    expect(screen.getByRole('search').getAttribute('class')).toContain('library-filter');
  });

  it('keeps the disabled Press workspace out of the desktop routes', () => {
    const router = createMemoryRouter(createDesktopRoutes(), { initialEntries: ['/press'] });
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('heading', { name: '没有找到这个页面' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '我的项目' })).not.toBeInTheDocument();
  });

  it('keeps the disabled Times module out of desktop routes', () => {
    const router = createMemoryRouter(createDesktopRoutes(), { initialEntries: ['/times'] });
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('heading', { name: '没有找到这个页面' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '时事' })).not.toBeInTheDocument();
  });

  it('guards JOJO Q&A with the same runtime feature flag as Web', async () => {
    const router = createMemoryRouter(createDesktopRoutes(), { initialEntries: ['/rag'] });
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '没有找到这个页面' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '提问范围' })).not.toBeInTheDocument();
  });
});
