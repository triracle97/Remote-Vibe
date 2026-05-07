import { describe, it, expect, vi } from 'vitest';
import { resolveTailscaleIPv4 } from '../tailscale.js';

describe('resolveTailscaleIPv4', () => {
  it('returns the IPv4 from `tailscale ip --4` output', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '100.64.1.5\n', stderr: '' });
    const ip = await resolveTailscaleIPv4({ exec });
    expect(ip).toBe('100.64.1.5');
    expect(exec).toHaveBeenCalledWith('tailscale', ['ip', '--4']);
  });

  it('throws when stdout has no IPv4', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '\n', stderr: '' });
    await expect(resolveTailscaleIPv4({ exec })).rejects.toThrow(/no Tailscale IPv4/i);
  });

  it('throws when the tailscale binary is missing', async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(resolveTailscaleIPv4({ exec })).rejects.toThrow(/tailscale CLI not found/i);
  });

  it('throws when tailscale exits with stderr', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'tailscaled is not running' });
    await expect(resolveTailscaleIPv4({ exec })).rejects.toThrow(/tailscaled is not running/);
  });

  it('returns only the first IPv4 if multiple lines', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '100.64.1.5\n100.64.1.6\n', stderr: '' });
    const ip = await resolveTailscaleIPv4({ exec });
    expect(ip).toBe('100.64.1.5');
  });
});
