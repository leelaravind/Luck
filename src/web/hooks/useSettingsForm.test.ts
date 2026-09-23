// @vitest-environment jsdom
// Settings form: the pause between autonomous rounds (AppSettings.roundPacingMs) and the pricing map sent
// on save (exactly the rows listed — the server treats it as the complete set, so removals are reflected).
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

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    defaultLimits: DEFAULT_LIMITS,
    animationSpeed: 'normal',
    roundPacingMs: 7000,
    reduceMotion: 'system',
    pricing: { 'openai:default-model': DEFAULT_ROW, 'anthropic:mine': USER_ROW },
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

describe('pricing map on save', () => {
  it('an edited default assumption becomes a user entry', () => {
    const rows = pricingToRows({ 'openai:default-model': DEFAULT_ROW }).map((r) => ({ ...r, input: '1.5', dirty: true }));
    const { pricing, errors } = rowsToPricing(rows, '2026-09-23');
    expect(errors).toEqual({});
    expect(pricing).toEqual({
      'openai:default-model': { inputPerMTokUsd: 1.5, outputPerMTokUsd: 2, source: 'user', asOf: '2026-09-23' },
    });
  });

  it('sends exactly the listed rows: removals are reflected; default assumptions cannot be removed', () => {
    const s = settings(); // stable identity: a new object per render would re-sync the form every render
    const { result } = renderHook(() => useSettingsForm(s));
    expect(result.current.patch?.pricing).toEqual({ 'anthropic:mine': USER_ROW, 'openai:default-model': DEFAULT_ROW });

    // Default assumptions cannot be removed.
    act(() => result.current.removeRow('openai:default-model'));
    expect(result.current.rows.map((r) => r.key)).toEqual(['anthropic:mine', 'openai:default-model']);

    act(() => result.current.removeRow('anthropic:mine'));
    expect(result.current.rows.map((r) => r.key)).toEqual(['openai:default-model']);
    expect(result.current.patch?.pricing).toEqual({ 'openai:default-model': DEFAULT_ROW });

    act(() => result.current.addRow('ollama:local'));
    act(() => result.current.updateRow('ollama:local', 'input', '0'));
    act(() => result.current.updateRow('ollama:local', 'output', '0'));
    expect(Object.keys(result.current.patch?.pricing ?? {}).sort()).toEqual(['ollama:local', 'openai:default-model']);
    expect(result.current.patch?.pricing?.['ollama:local']?.source).toBe('user');
  });
});
