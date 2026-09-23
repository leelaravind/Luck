// @vitest-environment jsdom
// Settings form: the pause between autonomous rounds (AppSettings.roundPacingMs) and the save patch
// (AppSettingsPatch): only changed fields, only edited/added pricing rows (merged by the server) and
// explicit removals in pricingRemove. Removability is decided by builtInPricingKeys, never by `source`.
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AppSettings, Pricing } from '../../shared/contracts';
import { DEFAULT_LIMITS } from '../../shared/contracts';
import {
  DEFAULT_ROUND_PACING_MS,
  pacingToInput,
  parsePacing,
  pricingToRows,
  rowsToPricing,
  useSettingsForm,
} from './useSettingsForm';

const DEFAULT_ROW: Pricing = { inputPerMTokUsd: 1, outputPerMTokUsd: 2, source: 'default-assumption', asOf: '2026-01-01' };
const USER_ROW: Pricing = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, source: 'user', asOf: '2026-09-01' };

/** A 'default-assumption' row whose key is NOT a built-in default (sent through the API, or left by an older version). */
const ORPHAN_ROW: Pricing = { inputPerMTokUsd: 5, outputPerMTokUsd: 6, source: 'default-assumption', asOf: '2025-01-01' };

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    defaultLimits: DEFAULT_LIMITS,
    animationSpeed: 'normal',
    roundPacingMs: 7000,
    reduceMotion: 'system',
    pricing: { 'openai:default-model': DEFAULT_ROW, 'anthropic:mine': USER_ROW },
    builtInPricingKeys: ['openai:default-model'],
    players: {},
    ...over,
  };
}

describe('pause between autonomous rounds', () => {
  it('parses seconds (0.1 s steps) into integer ms and rejects junk or out-of-range values', () => {
    expect(parsePacing('7')).toEqual({ ms: 7000, error: null });
    expect(parsePacing(' 2.5 ')).toEqual({ ms: 2500, error: null });
    expect(parsePacing('0')).toEqual({ ms: 0, error: null });
    expect(parsePacing('600')).toEqual({ ms: 600_000, error: null });
    expect(parsePacing('0.1')).toEqual({ ms: 100, error: null });
    for (const bad of ['', 'soon', '-1', '1e3', '2.55', '601', '1,5']) {
      expect(parsePacing(bad).ms).toBeNull();
      expect(parsePacing(bad).error).toMatch(/Enter seconds from 0 to 600/);
    }
  });

  it('formats ms for the field and round-trips', () => {
    expect(pacingToInput(7000)).toBe('7');
    expect(pacingToInput(2500)).toBe('2.5');
    expect(pacingToInput(600)).toBe('0.6');
    for (const ms of [0, 100, 2500, 7000, 600_000]) expect(parsePacing(pacingToInput(ms)).ms).toBe(ms);
  });

  it('is prefilled from the server, sent only when changed, and blocks saving while invalid', () => {
    const { result, rerender } = renderHook((p: { s: AppSettings | null }) => useSettingsForm(p.s), {
      initialProps: { s: settings({ roundPacingMs: 3000 }) },
    });
    expect(result.current.pacingSec).toBe('3');
    expect(result.current.patch).not.toBeNull();
    expect(result.current.patch).not.toHaveProperty('roundPacingMs');

    act(() => result.current.setPacingSec('12.5'));
    expect(result.current.pacingError).toBeNull();
    expect(result.current.patch?.roundPacingMs).toBe(12_500);

    act(() => result.current.setPacingSec('later'));
    expect(result.current.pacingError).toMatch(/Enter seconds/);
    expect(result.current.patch).toBeNull();

    // A saved value from the server re-syncs the field.
    rerender({ s: settings({ roundPacingMs: 12_500 }) });
    expect(result.current.pacingSec).toBe('12.5');
    expect(result.current.patch).not.toHaveProperty('roundPacingMs');
  });

  it('falls back to the documented default when the server reports no value', () => {
    const legacy = { ...settings() } as Partial<AppSettings>;
    delete legacy.roundPacingMs;
    const { result } = renderHook(() => useSettingsForm(legacy as AppSettings));
    expect(DEFAULT_ROUND_PACING_MS).toBe(7000);
    expect(result.current.pacingSec).toBe('7');
    expect(result.current.patch).not.toHaveProperty('roundPacingMs');
  });
});

describe('pricing on save (AppSettingsPatch)', () => {
  it('an edited default assumption becomes a user entry', () => {
    const rows = pricingToRows({ 'openai:default-model': DEFAULT_ROW }, ['openai:default-model']).map((r) => ({ ...r, input: '1.5', dirty: true }));
    const { pricing, errors } = rowsToPricing(rows, '2026-09-23');
    expect(errors).toEqual({});
    expect(pricing).toEqual({
      'openai:default-model': { inputPerMTokUsd: 1.5, outputPerMTokUsd: 2, source: 'user', asOf: '2026-09-23' },
    });
  });

  it('marks rows built-in by key (builtInPricingKeys), not by source', () => {
    const rows = pricingToRows(
      { 'openai:default-model': DEFAULT_ROW, 'openai:orphan-fixture': ORPHAN_ROW, 'anthropic:mine': USER_ROW },
      ['openai:default-model'],
    );
    expect(rows.map((r) => [r.key, r.source, r.builtIn])).toEqual([
      ['anthropic:mine', 'user', false],
      ['openai:default-model', 'default-assumption', true],
      ['openai:orphan-fixture', 'default-assumption', false],
    ]);
    // No list from the server: nothing is treated as built in.
    expect(pricingToRows({ 'openai:default-model': DEFAULT_ROW }).map((r) => r.builtIn)).toEqual([false]);
  });

  it('sends nothing for untouched rows: no pricing map and no removals', () => {
    const s = settings(); // stable identity: a new object per render would re-sync the form every render
    const { result } = renderHook(() => useSettingsForm(s));
    expect(result.current.patch).toEqual({});
    expect(result.current.unsaved).toBe(false);
  });

  it('built-in rows cannot be removed; user rows are sent in pricingRemove, not by leaving them out', () => {
    const s = settings();
    const { result } = renderHook(() => useSettingsForm(s));

    act(() => result.current.removeRow('openai:default-model'));
    expect(result.current.rows.map((r) => r.key)).toEqual(['anthropic:mine', 'openai:default-model']);
    expect(result.current.patch).toEqual({});

    act(() => result.current.removeRow('anthropic:mine'));
    expect(result.current.rows.map((r) => r.key)).toEqual(['openai:default-model']);
    expect(result.current.patch).toEqual({ pricingRemove: ['anthropic:mine'] });
    expect(result.current.unsaved).toBe(true);
  });

  it('a built-in row the user overrode can be reset to the default (sent in pricingRemove); editing cancels the reset', () => {
    const overridden: Pricing = { inputPerMTokUsd: 9, outputPerMTokUsd: 9, source: 'user', asOf: '2026-09-02' };
    const s = settings({ pricing: { 'openai:default-model': overridden, 'anthropic:mine': USER_ROW } });
    const { result } = renderHook(() => useSettingsForm(s));

    // A built-in row that was NOT overridden cannot be reset (nothing to drop).
    const plain = settings();
    const { result: plainResult } = renderHook(() => useSettingsForm(plain));
    act(() => plainResult.current.resetRow('openai:default-model'));
    expect(plainResult.current.patch).toEqual({});

    act(() => result.current.resetRow('openai:default-model'));
    expect(result.current.rows.find((r) => r.key === 'openai:default-model')?.resetPending).toBe(true);
    expect(result.current.patch).toEqual({ pricingRemove: ['openai:default-model'] });
    // A non-built-in key is not "reset" (it is removed with removeRow instead).
    act(() => result.current.resetRow('anthropic:mine'));
    expect(result.current.patch).toEqual({ pricingRemove: ['openai:default-model'] });
    // "Add" with a key already in the table changes nothing: the pending reset is still sent.
    act(() => result.current.addRow('openai:default-model'));
    expect(result.current.rows.find((r) => r.key === 'openai:default-model')?.resetPending).toBe(true);
    expect(result.current.patch).toEqual({ pricingRemove: ['openai:default-model'] });

    // Editing the row again cancels the pending reset and sends the edit instead.
    act(() => result.current.updateRow('openai:default-model', 'input', '4'));
    expect(result.current.rows.find((r) => r.key === 'openai:default-model')?.resetPending).toBe(false);
    expect(result.current.patch?.pricingRemove).toBeUndefined();
    expect(result.current.patch?.pricing?.['openai:default-model']?.inputPerMTokUsd).toBe(4);
  });

  it('actions in one batch see each other (rows and removals change together)', () => {
    const s = settings({ pricing: { 'anthropic:mine': USER_ROW } }); // one object: a new one per render would re-sync forever
    const { result } = renderHook(() => useSettingsForm(s));
    act(() => {
      result.current.addRow('openai:fixture-new');
      result.current.addRow('openai:fixture-new');
    });
    expect(result.current.rows.filter((r) => r.key === 'openai:fixture-new')).toHaveLength(1);
    // Removed and added again in the same batch: the row stays and is not deleted on save.
    act(() => {
      result.current.removeRow('anthropic:mine');
      result.current.addRow('anthropic:mine');
    });
    expect(result.current.rows.some((r) => r.key === 'anthropic:mine')).toBe(true);
    expect(result.current.patch?.pricingRemove).toBeUndefined();
  });

  it('an orphan default-assumption row (key not built in) is removable', () => {
    const s = settings({ pricing: { 'openai:default-model': DEFAULT_ROW, 'openai:orphan-fixture': ORPHAN_ROW } });
    const { result } = renderHook(() => useSettingsForm(s));
    expect(result.current.rows.find((r) => r.key === 'openai:orphan-fixture')?.builtIn).toBe(false);
    act(() => result.current.removeRow('openai:orphan-fixture'));
    expect(result.current.rows.map((r) => r.key)).toEqual(['openai:default-model']);
    expect(result.current.patch).toEqual({ pricingRemove: ['openai:orphan-fixture'] });
  });

  it('sends only edited / added rows (merged by the server) and keeps adds and removals consistent', () => {
    const s = settings();
    const { result } = renderHook(() => useSettingsForm(s));

    act(() => result.current.addRow('ollama:local-fixture'));
    act(() => result.current.updateRow('ollama:local-fixture', 'input', '0'));
    act(() => result.current.updateRow('ollama:local-fixture', 'output', '0'));
    act(() => result.current.updateRow('openai:default-model', 'input', '1.5'));
    expect(Object.keys(result.current.patch?.pricing ?? {}).sort()).toEqual(['ollama:local-fixture', 'openai:default-model']);
    expect(result.current.patch?.pricing?.['ollama:local-fixture']?.source).toBe('user');
    expect(result.current.patch?.pricing?.['openai:default-model']).toMatchObject({ inputPerMTokUsd: 1.5, source: 'user' });
    expect(result.current.patch?.pricing).not.toHaveProperty(['anthropic:mine']);
    expect(result.current.patch).not.toHaveProperty('pricingRemove');

    // A row added here and removed again never reached the server: nothing to delete.
    act(() => result.current.removeRow('ollama:local-fixture'));
    expect(result.current.patch?.pricing).not.toHaveProperty(['ollama:local-fixture']);
    expect(result.current.patch).not.toHaveProperty('pricingRemove');

    // Removed, then added again: saved as a new value, not deleted.
    act(() => result.current.removeRow('anthropic:mine'));
    expect(result.current.patch?.pricingRemove).toEqual(['anthropic:mine']);
    act(() => result.current.addRow('anthropic:mine'));
    act(() => result.current.updateRow('anthropic:mine', 'input', '4'));
    act(() => result.current.updateRow('anthropic:mine', 'output', '20'));
    expect(result.current.patch).not.toHaveProperty('pricingRemove');
    expect(result.current.patch?.pricing?.['anthropic:mine']).toMatchObject({ inputPerMTokUsd: 4, outputPerMTokUsd: 20, source: 'user' });
  });

  it('only edited rows are validated; an untouched server row never blocks the save', () => {
    const odd: Pricing = { inputPerMTokUsd: 1e-7, outputPerMTokUsd: 2, source: 'user' };
    const s = settings({ pricing: { 'openai:odd-fixture': odd } });
    const { result } = renderHook(() => useSettingsForm(s));
    expect(result.current.pricingErrors).toEqual({});
    expect(result.current.patch).toEqual({});
    act(() => result.current.updateRow('openai:odd-fixture', 'input', 'lots'));
    expect(result.current.pricingErrors).toHaveProperty(['openai:odd-fixture']);
    expect(result.current.patch).toBeNull();
    expect(result.current.unsaved).toBe(true);
  });

  it('a re-sync from the server (after a save or a refresh) clears the removals and shows the server rows', () => {
    const { result, rerender } = renderHook((p: { s: AppSettings }) => useSettingsForm(p.s), { initialProps: { s: settings() } });
    act(() => result.current.removeRow('anthropic:mine'));
    expect(result.current.patch?.pricingRemove).toEqual(['anthropic:mine']);
    const saved = settings({ pricing: { 'openai:default-model': DEFAULT_ROW } });
    rerender({ s: saved });
    expect(result.current.rows.map((r) => r.key)).toEqual(['openai:default-model']);
    expect(result.current.patch).toEqual({});
  });
});

describe('only changed fields are sent', () => {
  it('limits, animation speed and reduce motion are sent only when they differ from the loaded server value', () => {
    const s = settings();
    const { result } = renderHook(() => useSettingsForm(s));
    expect(result.current.patch).toEqual({});

    act(() => result.current.setAnimationSpeed('fast'));
    expect(result.current.patch).toEqual({ animationSpeed: 'fast' });
    act(() => result.current.setAnimationSpeed('normal'));
    expect(result.current.patch).toEqual({});

    act(() => result.current.setReduceMotion('on'));
    expect(result.current.patch).toEqual({ reduceMotion: 'on' });
    act(() => result.current.setReduceMotion('system'));

    act(() => result.current.limitsForm.setValue('maxRounds', '25'));
    expect(result.current.patch?.defaultLimits).toEqual({ ...DEFAULT_LIMITS, maxRounds: 25 });
    expect(Object.keys(result.current.patch ?? {})).toEqual(['defaultLimits']);
    expect(result.current.unsaved).toBe(true);
  });

  it('never sends the read-only builtInPricingKeys', () => {
    const s = settings();
    const { result } = renderHook(() => useSettingsForm(s));
    act(() => result.current.removeRow('anthropic:mine'));
    act(() => result.current.setAnimationSpeed('instant'));
    expect(result.current.patch).not.toHaveProperty('builtInPricingKeys');
    expect(result.current.patch).toEqual({ animationSpeed: 'instant', pricingRemove: ['anthropic:mine'] });
  });
});
