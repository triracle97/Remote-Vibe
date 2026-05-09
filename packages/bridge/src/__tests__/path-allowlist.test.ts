import { describe, it, expect } from 'vitest';
import { makePathValidator, PathOutsideAllowlistError } from '../path-allowlist.js';

describe('makePathValidator', () => {
  it('returns the realpath when inside an allowed dir', async () => {
    const validate = makePathValidator({
      allowedDirs: ['/Users/me/code'],
      realpath: async (p) => p,
    });
    await expect(validate('/Users/me/code/proj')).resolves.toBe('/Users/me/code/proj');
  });

  it('throws PathOutsideAllowlistError when realpath escapes the allowlist', async () => {
    const validate = makePathValidator({
      allowedDirs: ['/Users/me/code'],
      realpath: async () => '/etc',
    });
    await expect(validate('/Users/me/code/proj')).rejects.toBeInstanceOf(PathOutsideAllowlistError);
  });

  it('throws PathOutsideAllowlistError when realpath itself rejects', async () => {
    const validate = makePathValidator({
      allowedDirs: ['/Users/me/code'],
      realpath: async () => { throw new Error('ENOENT'); },
    });
    await expect(validate('/missing')).rejects.toBeInstanceOf(PathOutsideAllowlistError);
  });

  it('matches any path when "/" is the allowed dir', async () => {
    const validate = makePathValidator({
      allowedDirs: ['/'],
      realpath: async (p) => p,
    });
    await expect(validate('/')).resolves.toBe('/');
    await expect(validate('/etc')).resolves.toBe('/etc');
    await expect(validate('/Users/me/deep/path')).resolves.toBe('/Users/me/deep/path');
  });

  it('treats /a/b as inside /a but rejects /ab (no false-prefix)', async () => {
    const validate = makePathValidator({
      allowedDirs: ['/a'],
      realpath: async (p) => p,
    });
    await expect(validate('/a/b')).resolves.toBe('/a/b');
    await expect(validate('/ab')).rejects.toBeInstanceOf(PathOutsideAllowlistError);
  });
});
