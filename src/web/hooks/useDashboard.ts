/**
 * Dashboard composition logic: combines the store with the local UI state (player draft, drawer,
 * dialog, sidebar, forms) and derives what may be shown while a result is still hidden.
 * App.tsx stays a layout file.
 */
import { useCallback, useMemo, useState } from 'react';
import type { CreateSessionRequest, ProviderCapabilities } from '../../shared/contracts';
import type { ApiClient } from '../api/client';
import { isDecisionVisible, isLogVisible } from '../state/reveal';
import { useLuck } from '../state/useLuck';
import { useDrawer } from './useDrawer';
import { useNewSessionForm } from './useNewSessionForm';
import { isAiKind, pricingKey, usePlayerDraft } from './usePlayerDraft';
import { useSettingsForm } from './useSettingsForm';
import { useTablePlay } from './useTablePlay';

export function useDashboard(api?: ApiClient) {
  const store = useLuck({ api });
  const { state, presentation: p, actions } = store;
  const table = useTablePlay(store);
  const player = usePlayerDraft({ providers: state.providers, settings: state.settings });
  const drawer = useDrawer();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const settingsForm = useSettingsForm(state.settings);
  const newSessionForm = useNewSessionForm(state.settings, dialogOpen);

  const session = state.snapshot?.session ?? null;

  /** Capabilities of the provider that plays the OPEN session (not the draft). */
  const sessionCapabilities: ProviderCapabilities | null = useMemo(() => {
    const kind = session?.player.kind;
    return kind && isAiKind(kind) ? (state.providers.find((x) => x.kind === kind)?.capabilities ?? null) : null;
  }, [session?.player.kind, state.providers]);

  // Hold back anything produced after a hidden round's outcome (see reveal.ts).
  const visible = useMemo(() => {
    if (!p) return { decisions: state.decisions, logs: state.logs, heldBack: 0 };
    const decisions = state.decisions.filter((d) => isDecisionVisible(d.roundNumber, p));
    const logs = state.logs.filter((l) => isLogVisible(l.createdAt, p));
    return {
      decisions,
      logs,
      heldBack: state.decisions.length - decisions.length + (state.logs.length - logs.length),
    };
  }, [p, state.decisions, state.logs]);

  const lastDecision = useMemo(() => {
    const d = state.snapshot?.lastDecision ?? null;
    if (d && p && isDecisionVisible(d.roundNumber, p)) return d;
    return visible.decisions[0] ?? null;
  }, [state.snapshot?.lastDecision, p, visible.decisions]);

  const { createSession, saveSettings, testProvider, loadModels } = actions;
  const onCreate = useCallback(
    async (req: CreateSessionRequest) => {
      const ok = await createSession(req);
      if (!ok) return;
      setDialogOpen(false);
      // Remember the last-used non-secret config for this provider.
      const kind = req.player.kind;
      if (isAiKind(kind) && state.settings) {
        void saveSettings({ players: { ...state.settings.players, [kind]: req.player } });
      }
    },
    [createSession, saveSettings, state.settings],
  );

  const onTest = useCallback(() => {
    if (isAiKind(player.kind)) void testProvider(player.kind, player.config);
  }, [player.kind, player.config, testProvider]);

  const onLoadModels = useCallback(() => {
    if (isAiKind(player.kind)) void loadModels(player.kind, player.config);
  }, [player.kind, player.config, loadModels]);

  const openNewSession = useCallback(() => {
    if (state.lastError?.scope === 'create') actions.clearError();
    setDialogOpen(true);
  }, [state.lastError, actions]);

  const suggestedPricingKey =
    isAiKind(player.kind) && player.provider?.capabilities.paid && player.config.model
      ? pricingKey(player.kind, player.config.model)
      : null;

  return {
    store,
    session,
    presentation: p,
    table,
    player,
    drawer,
    dialog: { open: dialogOpen, openNewSession, close: () => setDialogOpen(false), onCreate },
    sidebar: { open: sidebarOpen, toggle: () => setSidebarOpen((v) => !v) },
    settingsForm,
    newSessionForm,
    sessionCapabilities,
    visible,
    lastDecision,
    onTest,
    onLoadModels,
    suggestedPricingKey,
  };
}
