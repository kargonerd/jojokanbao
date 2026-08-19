import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CloseChoiceDialog } from './CloseChoiceDialog';

afterEach(cleanup);

describe('CloseChoiceDialog', () => {
  it('saves one simple close behavior choice', () => {
    const onChoose = vi.fn();
    render(<CloseChoiceDialog open onChoose={onChoose} />);

    expect(screen.getByRole('dialog', { name: '关闭窗口' })).toBeVisible();
    expect(screen.getByRole('radio', { name: /最小化到系统托盘/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /直接退出应用/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(onChoose).toHaveBeenCalledOnce();
    expect(onChoose).toHaveBeenCalledWith('quit');
  });

  it('leaves the preference unset when cancelled', () => {
    const onChoose = vi.fn();
    const { container } = render(<CloseChoiceDialog open onChoose={onChoose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(container.querySelector('.close-choice-backdrop')!);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onChoose).toHaveBeenCalledTimes(3);
    expect(onChoose).toHaveBeenNthCalledWith(1, 'cancel');
  });
});
