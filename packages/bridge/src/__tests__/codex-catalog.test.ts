import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listCodexModels,
  parseCodexCatalog,
  setCodexCatalogExecForTests,
  type CodexCatalogExec,
} from '../codex-catalog.js';

const SAMPLE = JSON.stringify({
  models: [
    {
      slug: 'gpt-hidden',
      display_name: 'Hidden',
      visibility: 'hide',
      priority: 1,
      supported_reasoning_levels: [{ effort: 'low' }],
    },
    {
      slug: 'gpt-5.6-luna',
      display_name: 'GPT-5.6-Luna',
      visibility: 'list',
      priority: 9,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
        { effort: 'max' },
        { effort: 'not-a-level' },
      ],
    },
    {
      slug: 'bad slug',
      display_name: 'Bad',
      visibility: 'list',
      priority: 0,
      supported_reasoning_levels: [{ effort: 'low' }],
    },
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      visibility: 'list',
      priority: 2,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
        { effort: 'max' },
        { effort: 'ultra' },
      ],
    },
    {
      slug: 'gpt-6-astra',
      display_name: 'Duplicate',
      visibility: 'list',
      priority: 3,
      supported_reasoning_levels: [{ effort: 'low' }],
    },
  ],
});

afterEach(() => {
  setCodexCatalogExecForTests(null);
});

describe('parseCodexCatalog', () => {
  it('keeps visible models, in priority order, and drops the rest', () => {
    expect(parseCodexCatalog(SAMPLE)).toEqual([
      {
        value: 'gpt-6-astra',
        label: 'GPT-6-Astra',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultEffort: 'medium',
      },
      {
        value: 'gpt-5.6-luna',
        label: 'GPT-5.6-Luna',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium',
      },
    ]);
  });

  it('rejects stdout that is not the catalog', () => {
    expect(() => parseCodexCatalog('not json')).toThrow(/JSON/);
    expect(() => parseCodexCatalog('{"ok":true}')).toThrow(/models/);
  });
});

describe('listCodexModels', () => {
  it('reads the CLI once and reuses the result', async () => {
    const exec = vi.fn<CodexCatalogExec>(async () => ({ stdout: SAMPLE }));
    setCodexCatalogExecForTests(exec);

    const first = listCodexModels();
    const second = listCodexModels();
    const [a, b] = await Promise.all([first, second]);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('codex', ['debug', 'models'], expect.objectContaining({ encoding: 'utf8' }));
    expect(a.source).toBe('cli');
    expect(a.models.map((m) => m.value)).toEqual(['gpt-6-astra', 'gpt-5.6-luna']);
    expect(b).toEqual(a);

    const third = await listCodexModels();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(third.models).toEqual(a.models);
  });

  it('falls back to the built-in list when the CLI fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setCodexCatalogExecForTests(async () => {
      throw new Error('spawn codex ENOENT');
    });
    const catalog = await listCodexModels();
    expect(catalog.source).toBe('fallback');
    expect(catalog.models.map((m) => m.value)).toEqual(['gpt-5-codex', 'gpt-5']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
