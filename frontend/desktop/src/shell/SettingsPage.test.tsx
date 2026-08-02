import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';

const getMineru = vi.fn();
const saveMineru = vi.fn();

beforeEach(() => {
  getMineru.mockReset().mockResolvedValue({ configured: false });
  saveMineru.mockReset().mockResolvedValue({ configured: true });
  window.jojoDesktop = {
    appName: 'test',
    engine: { invoke: vi.fn() },
    settings: { getMineru, saveMineru },
  };
});

describe('MinerU settings', () => {
  it('does not reveal the stored key and saves a replacement through Electron', async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => expect(getMineru).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('MinerU API Key'), { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 API Key' }));
    await waitFor(() => expect(saveMineru).toHaveBeenCalledWith('secret-token'));
    expect(screen.getByLabelText('MinerU API Key')).toHaveValue('');
    expect(screen.getByText('API Key 已安全保存')).toBeInTheDocument();
  });
});
