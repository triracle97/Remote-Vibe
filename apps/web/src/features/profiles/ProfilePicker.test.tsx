import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ProfilePicker } from './ProfilePicker';
import { useProfileStore } from './profileStore';
import type { Profile } from '../../types/protocol';

vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: () => ({ send: vi.fn() }),
}));

const mk = (over: Partial<Profile> = {}): Profile => ({
  name: 'main',
  agent: 'claude',
  dirs: ['/Users/me/repo'],
  account: null,
  default: false,
  ...over,
});

describe('ProfilePicker', () => {
  beforeEach(() => {
    useProfileStore.setState({ profiles: [], loading: false });
  });

  it('returns nothing when no profiles match agent and no onManage', () => {
    useProfileStore.setState({
      profiles: [mk({ name: 'cx', agent: 'codex' })],
    });
    const { container } = render(<ProfilePicker agent="claude" onSelect={() => {}} />);
    expect(container.querySelector('.profile-picker-select')).toBeNull();
    expect(container.querySelector('.profile-picker-manage')).toBeNull();
  });

  it('renders only the Manage button when no matching profiles + onManage provided', () => {
    useProfileStore.setState({
      profiles: [mk({ name: 'cx', agent: 'codex' })],
    });
    const { container } = render(
      <ProfilePicker agent="claude" onSelect={() => {}} onManage={() => {}} />,
    );
    expect(container.querySelector('.profile-picker-select')).toBeNull();
    expect(container.querySelector('.profile-picker-manage')).toBeTruthy();
  });

  it('lists only profiles for the requested agent', () => {
    useProfileStore.setState({
      profiles: [
        mk({ name: 'a', agent: 'claude' }),
        mk({ name: 'b', agent: 'codex' }),
        mk({ name: 'c', agent: 'claude', default: true, dirs: ['/x', '/y'] }),
      ],
    });
    const { container } = render(<ProfilePicker agent="claude" onSelect={() => {}} />);
    const select = container.querySelector('.profile-picker-select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    const options = Array.from(select.querySelectorAll('option'));
    // 1 placeholder + 2 claude profiles
    expect(options).toHaveLength(3);
    expect(options[0]?.value).toBe('');
    expect(options[1]?.value).toBe('a');
    expect(options[2]?.value).toBe('c');
    expect(options[2]?.textContent).toMatch(/default/);
    expect(options[2]?.textContent).toMatch(/2 dirs/);
    expect(options[1]?.textContent).toMatch(/1 dir(\b|[^s])/);
  });

  it('onChange dispatches onSelect with the picked profile and resets to placeholder', () => {
    const profiles = [mk({ name: 'a' }), mk({ name: 'b', dirs: ['/x'] })];
    useProfileStore.setState({ profiles });
    const onSelect = vi.fn();
    const { container } = render(<ProfilePicker agent="claude" onSelect={onSelect} />);
    const select = container.querySelector('.profile-picker-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'b' } });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toEqual(profiles[1]);
    expect(select.value).toBe('');
  });

  it('onChange to placeholder is a no-op', () => {
    useProfileStore.setState({ profiles: [mk({ name: 'a' })] });
    const onSelect = vi.fn();
    const { container } = render(<ProfilePicker agent="claude" onSelect={onSelect} />);
    const select = container.querySelector('.profile-picker-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('clicking Manage button calls onManage', () => {
    useProfileStore.setState({ profiles: [mk({ name: 'a' })] });
    const onManage = vi.fn();
    const { container } = render(
      <ProfilePicker agent="claude" onSelect={() => {}} onManage={onManage} />,
    );
    const btn = container.querySelector('.profile-picker-manage') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});
