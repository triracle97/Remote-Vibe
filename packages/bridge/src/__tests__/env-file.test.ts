import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../env-file';

describe('loadEnvFile', () => {
  let dir: string;
  let envPath: string;
  let savedEnv: Record<string, string | undefined>;
  const guardKeys = ['ENV_FILE_TEST_A', 'ENV_FILE_TEST_B', 'ENV_FILE_TEST_C', 'ENV_FILE_TEST_QUOTED', 'ENV_FILE_TEST_EXPORT'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'envfile-'));
    envPath = join(dir, '.env');
    savedEnv = {};
    for (const k of guardKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of guardKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('returns 0 when file is missing', () => {
    expect(loadEnvFile(envPath)).toBe(0);
  });

  it('applies KEY=VALUE pairs to process.env', () => {
    writeFileSync(envPath, 'ENV_FILE_TEST_A=hello\nENV_FILE_TEST_B=world\n');
    expect(loadEnvFile(envPath)).toBe(2);
    expect(process.env.ENV_FILE_TEST_A).toBe('hello');
    expect(process.env.ENV_FILE_TEST_B).toBe('world');
  });

  it('does NOT overwrite existing env values', () => {
    process.env.ENV_FILE_TEST_A = 'from-shell';
    writeFileSync(envPath, 'ENV_FILE_TEST_A=from-file\nENV_FILE_TEST_B=from-file\n');
    const applied = loadEnvFile(envPath);
    expect(applied).toBe(1);
    expect(process.env.ENV_FILE_TEST_A).toBe('from-shell');
    expect(process.env.ENV_FILE_TEST_B).toBe('from-file');
  });

  it('skips comments and blank lines', () => {
    writeFileSync(
      envPath,
      [
        '# header comment',
        '',
        'ENV_FILE_TEST_A=alpha',
        '   ',
        '# another comment',
        'ENV_FILE_TEST_B=beta',
      ].join('\n'),
    );
    expect(loadEnvFile(envPath)).toBe(2);
    expect(process.env.ENV_FILE_TEST_A).toBe('alpha');
    expect(process.env.ENV_FILE_TEST_B).toBe('beta');
  });

  it('strips matching surrounding double-quotes and single-quotes', () => {
    writeFileSync(
      envPath,
      'ENV_FILE_TEST_A="alpha bravo"\nENV_FILE_TEST_B=\'charlie delta\'\nENV_FILE_TEST_QUOTED="multi\\nline"\n',
    );
    loadEnvFile(envPath);
    expect(process.env.ENV_FILE_TEST_A).toBe('alpha bravo');
    expect(process.env.ENV_FILE_TEST_B).toBe('charlie delta');
    expect(process.env.ENV_FILE_TEST_QUOTED).toBe('multi\nline');
  });

  it('accepts `export KEY=value` prefix', () => {
    writeFileSync(envPath, 'export ENV_FILE_TEST_EXPORT=exported\n');
    loadEnvFile(envPath);
    expect(process.env.ENV_FILE_TEST_EXPORT).toBe('exported');
  });

  it('skips invalid KEY names (starts with digit, has dashes)', () => {
    writeFileSync(envPath, '1BAD=skip\nbad-name=skip\nENV_FILE_TEST_A=ok\n');
    expect(loadEnvFile(envPath)).toBe(1);
    expect(process.env.ENV_FILE_TEST_A).toBe('ok');
  });

  it('preserves `=` inside values (only first = is the separator)', () => {
    writeFileSync(envPath, 'ENV_FILE_TEST_A=key=value=more\n');
    loadEnvFile(envPath);
    expect(process.env.ENV_FILE_TEST_A).toBe('key=value=more');
  });
});
