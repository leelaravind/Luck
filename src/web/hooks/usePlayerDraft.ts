/**
 * Player configuration being prepared for the NEXT session (a session's player is fixed at creation).
 * Initial values come only from real sources: the last-used config saved in settings, or the server's
 * non-secret defaults (.env). No model name is ever hardcoded in the UI.
 */
import { useCallback, useMemo, useState } from 'react';
import type { AiProviderKind, AppSettings, PlayerConfig, PlayerKind, ProviderStatus } from '../../shared/contracts';
import { AI_PROVIDER_KINDS } from '../../shared/contracts';

export interface PlayerDraftFields {
  model: string;
  baseUrl: string;
  layaCheckpoint: string;
}

/** Which free-text fields each provider accepts (PlayerConfig docs: endpoint for ollama/openai/laya). */
export const PROVIDER_FIELDS: Record<AiProviderKind, { model: boolean; baseUrl: boolean; checkpoint: boolean }> = {
  ollama: { model: true, baseUrl: true, checkpoint: false },
  anthropic: { model: true, baseUrl: false, checkpoint: false },
  openai: { model: true, baseUrl: true, checkpoint: false },
  'claude-cli': { model: true, baseUrl: false, checkpoint: false },
  laya: { model: false, baseUrl: true, checkpoint: true },
};

export function isAiKind(kind: PlayerKind): kind is AiProviderKind {
  return (AI_PROVIDER_KINDS as readonly string[]).includes(kind);
}

function initialFields(kind: AiProviderKind, settings: AppSettings | null, provider: ProviderStatus | undefined): PlayerDraftFields {
  const saved = settings?.players?.[kind];
  return {
    model: saved?.model ?? provider?.defaults.model ?? '',
    baseUrl: saved?.baseUrl ?? provider?.defaults.baseUrl ?? '',
    layaCheckpoint: saved?.layaCheckpoint ?? provider?.defaults.layaCheckpoint ?? '',
  };
}

export function pricingKey(kind: PlayerKind, model: string | undefined): string {
  return `${kind}:${model ?? ''}`;
}

/** Build the non-secret PlayerConfig sent to POST /api/sessions and provider test/model routes. */
export function buildPlayerConfig(
  kind: PlayerKind,
  fields: PlayerDraftFields,
  settings: AppSettings | null,
): PlayerConfig {
  if (!isAiKind(kind)) return { kind };
  const f = PROVIDER_FIELDS[kind];
  const cfg: PlayerConfig = { kind };
  const model = fields.model.trim();
  if (f.model && model) cfg.model = model;
  const baseUrl = fields.baseUrl.trim();
  if (f.baseUrl && baseUrl) cfg.baseUrl = baseUrl;
  const checkpoint = fields.layaCheckpoint.trim();
  if (f.checkpoint && checkpoint) cfg.layaCheckpoint = checkpoint;
  const pricing = settings?.pricing?.[pricingKey(kind, cfg.model)];
  if (pricing) cfg.pricing = pricing;
  return cfg;
}

export interface UsePlayerDraftOptions {
  readonly providers: readonly ProviderStatus[];
  readonly settings: AppSettings | null;
}

export function usePlayerDraft({ providers, settings }: UsePlayerDraftOptions) {
  const [kind, setKindState] = useState<PlayerKind>('manual');
  // Per-provider edits survive switching back and forth.
  const [edits, setEdits] = useState<Partial<Record<AiProviderKind, PlayerDraftFields>>>({});

  const provider = isAiKind(kind) ? providers.find((p) => p.kind === kind) : undefined;
  const fields: PlayerDraftFields = isAiKind(kind)
    ? (edits[kind] ?? initialFields(kind, settings, provider))
    : { model: '', baseUrl: '', layaCheckpoint: '' };

  const setKind = useCallback((k: PlayerKind) => setKindState(k), []);
  const setField = useCallback(
    (field: keyof PlayerDraftFields, value: string) => {
      if (!isAiKind(kind)) return;
      setEdits((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? initialFields(kind, settings, provider)), [field]: value } }));
    },
    [kind, settings, provider],
  );

  const config = useMemo(() => buildPlayerConfig(kind, fields, settings), [kind, fields, settings]);

  return { kind, setKind, fields, setField, provider, config };
}

export type PlayerDraft = ReturnType<typeof usePlayerDraft>;
