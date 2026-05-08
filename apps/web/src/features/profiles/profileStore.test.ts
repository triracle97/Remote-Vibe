import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useProfileStore } from './profileStore';
import type { Profile } from '../../types/protocol';

vi.mock('../../services/bridge-client-singleton', () => ({
  getBridgeClient: vi.fn(),
}));

import { getBridgeClient } from '../../services/bridge-client-singleton';

const mkProfile = (over: Partial<Profile> = {}): Profile => ({
  name: 'main',
  agent: 'claude',
  dirs: ['/Users/me/repo'],
  account: null,
  default: false,
  ...over,
});

describe('profileStore', () => {
  beforeEach(() => {
    useProfileStore.setState({ profiles: [], loading: false });
    vi.clearAllMocks();
  });

  it('fetch() sends list_profiles and sets loading=true', () => {
    const send = vi.fn();
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });
    useProfileStore.getState().fetch();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'list_profiles', correlationId: expect.any(String) }),
    );
    expect(useProfileStore.getState().loading).toBe(true);
  });

  it('applyServerMsg profile_list populates profiles + clears loading', () => {
    useProfileStore.setState({ loading: true });
    const profiles = [mkProfile(), mkProfile({ name: 'work' })];
    useProfileStore.getState().applyServerMsg({
      type: 'profile_list',
      profiles,
      correlationId: 'x',
    });
    const s = useProfileStore.getState();
    expect(s.profiles).toEqual(profiles);
    expect(s.loading).toBe(false);
  });

  it('save() sends save_profile and resolves on profile_saved (replacing existing)', async () => {
    const sent: unknown[] = [];
    const send = vi.fn((m: unknown) => sent.push(m));
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });

    const original = mkProfile({ dirs: ['/a'] });
    useProfileStore.setState({ profiles: [original] });

    const updated = mkProfile({ dirs: ['/a', '/b'] });
    const promise = useProfileStore.getState().save(updated);
    expect(send).toHaveBeenCalledTimes(1);
    const sentMsg = sent[0] as { type: string; profile: Profile; correlationId: string };
    expect(sentMsg.type).toBe('save_profile');
    expect(sentMsg.profile).toEqual(updated);

    useProfileStore.getState().applyServerMsg({
      type: 'profile_saved',
      profile: updated,
      correlationId: sentMsg.correlationId,
    });

    await expect(promise).resolves.toBeUndefined();
    const profs = useProfileStore.getState().profiles;
    expect(profs).toHaveLength(1);
    expect(profs[0]?.dirs).toEqual(['/a', '/b']);
  });

  it('delete() sends delete_profile and resolves on profile_deleted', async () => {
    const sent: unknown[] = [];
    const send = vi.fn((m: unknown) => sent.push(m));
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });

    useProfileStore.setState({ profiles: [mkProfile({ name: 'a' }), mkProfile({ name: 'b' })] });

    const promise = useProfileStore.getState().delete('a', 'claude');
    const sentMsg = sent[0] as { type: string; correlationId: string };
    expect(sentMsg.type).toBe('delete_profile');

    useProfileStore.getState().applyServerMsg({
      type: 'profile_deleted',
      name: 'a',
      agent: 'claude',
      correlationId: sentMsg.correlationId,
    });
    await expect(promise).resolves.toBeUndefined();
    const profs = useProfileStore.getState().profiles;
    expect(profs.map((p) => p.name)).toEqual(['b']);
  });

  it('setDefault() sends set_default_profile and resolves on profile_default_set; flips defaults', async () => {
    const sent: unknown[] = [];
    const send = vi.fn((m: unknown) => sent.push(m));
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });

    useProfileStore.setState({
      profiles: [
        mkProfile({ name: 'a', default: true }),
        mkProfile({ name: 'b', default: false }),
      ],
    });

    const promise = useProfileStore.getState().setDefault('b', 'claude');
    const sentMsg = sent[0] as { type: string; correlationId: string };
    expect(sentMsg.type).toBe('set_default_profile');

    useProfileStore.getState().applyServerMsg({
      type: 'profile_default_set',
      name: 'b',
      agent: 'claude',
      correlationId: sentMsg.correlationId,
    });
    await expect(promise).resolves.toBeUndefined();
    const profs = useProfileStore.getState().profiles;
    expect(profs.find((p) => p.name === 'a')?.default).toBe(false);
    expect(profs.find((p) => p.name === 'b')?.default).toBe(true);
  });

  it('error reply with matching correlationId rejects the pending promise', async () => {
    const sent: unknown[] = [];
    const send = vi.fn((m: unknown) => sent.push(m));
    (getBridgeClient as ReturnType<typeof vi.fn>).mockReturnValue({ send });

    const promise = useProfileStore.getState().save(mkProfile());
    const sentMsg = sent[0] as { correlationId: string };

    useProfileStore.getState().applyServerMsg({
      type: 'error',
      code: 'profile_dirs_disallowed',
      message: 'bad dirs',
      correlationId: sentMsg.correlationId,
    });

    await expect(promise).rejects.toEqual({
      code: 'profile_dirs_disallowed',
      message: 'bad dirs',
    });
  });
});
