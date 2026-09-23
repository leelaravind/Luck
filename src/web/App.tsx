/**
 * Luck — AI Roulette Lab dashboard (layout adapted from the Stitch export in design-references/).
 * Header · ONE compact sidebar (player, provider config, usage, latest decision) · main column with the
 * status strip, the felt (recent results | large wheel | last round), the complete betting table and the
 * apron control bar, and a collapsible details drawer. All data is live server state.
 */
import type { ApiClient } from './api/client';
import { COPY } from './copy';
import { EmptyState } from './components/common/EmptyState';
import { InlineError } from './components/common/InlineError';
import { LiveRegion } from './components/common/LiveRegion';
import { ControlBar } from './components/controls/ControlBar';
import { AppHeader } from './components/layout/AppHeader';
import { BottomDrawer } from './components/layout/BottomDrawer';
import { FeltStage } from './components/layout/FeltStage';
import { Sidebar } from './components/layout/Sidebar';
import { SidebarToggle } from './components/layout/SidebarToggle';
import { StatusStrip } from './components/layout/StatusStrip';
import { BalanceChart } from './components/panels/BalanceChart';
import { LastRoundPanel } from './components/panels/LastRoundPanel';
import { LatestDecisionCard } from './components/panels/LatestDecisionCard';
import { LogsDecisionsPanel } from './components/panels/LogsDecisionsPanel';
import { NewSessionDialog } from './components/panels/NewSessionDialog';
import { PlayerPanel } from './components/panels/PlayerPanel';
import { RawJsonPanel } from './components/panels/RawJsonPanel';
import { RecentResultsPanel } from './components/panels/RecentResultsPanel';
import { RoundLedger } from './components/panels/RoundLedger';
import { SessionHistory } from './components/panels/SessionHistory';
import { SettingsPanel } from './components/panels/SettingsPanel';
import { TableFeedback } from './components/panels/TableFeedback';
import { UsagePanel } from './components/panels/UsagePanel';
import { BettingTable } from './components/table/BettingTable';
import { RouletteWheel } from './components/wheel/RouletteWheel';
import { useDashboard } from './hooks/useDashboard';

export interface AppProps {
  /** Injected in tests; defaults to the same-origin API client. */
  readonly api?: ApiClient;
}

const SIDEBAR_ID = 'luck-sidebar';

export function App({ api }: Readonly<AppProps>) {
  const d = useDashboard(api);
  const { store, session, presentation: p, table, player, drawer } = d;
  const { state, actions } = store;
  const snapshot = state.snapshot;
  const providerError = state.lastError?.scope === 'provider' ? state.lastError : null;
  // Errors without a closer home (a settings save error shows here unless the Settings tab is open).
  const settingsVisible = drawer.open && drawer.tab === 'settings';
  const pageError =
    state.lastError &&
    (state.lastError.scope === 'load' ||
      state.lastError.scope === 'session' ||
      (state.lastError.scope === 'settings' && !settingsVisible))
      ? state.lastError
      : null;

  return (
    <div className="min-h-dvh bg-ivory text-ink">
      <a
        href="#luck-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-card focus:px-3 focus:py-2 focus:shadow-overlay"
      >
        Skip to the table
      </a>
      <AppHeader
        sessions={state.sessions}
        selectedId={state.selectedSessionId}
        onSelect={actions.selectSession}
        onPickerOpen={d.onSessionPickerOpen}
        onNewSession={d.dialog.openNewSession}
        onOpenSettings={() => drawer.openTab('settings')}
        streaming={!!snapshot && snapshot.session.id === state.selectedSessionId}
        connection={state.connection}
        serverReachable={state.serverReachable}
        version={state.health?.version ?? null}
        lastEventAt={state.lastEventAt}
      />
      <LiveRegion message={store.announcement} />

      <div className="mx-auto flex w-full max-w-[1920px] flex-col gap-3 px-4 py-3 md:flex-row md:items-start xl:gap-4 xl:px-6">
        <div className="md:hidden">
          <SidebarToggle controls={SIDEBAR_ID} open={d.sidebar.open} onToggle={d.sidebar.toggle} />
        </div>
        <Sidebar id={SIDEBAR_ID} open={d.sidebar.open}>
          <PlayerPanel
            session={session}
            providers={state.providers}
            providerTests={state.providerTests}
            providerModels={state.providerModels}
            player={player}
            busy={state.busy}
            providerError={providerError}
            onDismissError={actions.clearError}
            onTest={d.onTest}
            onLoadModels={d.onLoadModels}
            onNewSession={d.dialog.openNewSession}
          />
          <UsagePanel
            mode={session?.mode ?? null}
            capabilities={d.sessionCapabilities}
            usage={snapshot?.usage ?? null}
            records={state.usageRecords}
          />
          <LatestDecisionCard decision={d.lastDecision} mode={session?.mode ?? null} usage={d.lastDecisionUsage} />
        </Sidebar>

        <main id="luck-main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="hidden md:block xl:hidden">
            <SidebarToggle controls={SIDEBAR_ID} open={d.sidebar.open} onToggle={d.sidebar.toggle} />
          </div>
          {pageError ? <InlineError message={pageError.message} code={pageError.code} onDismiss={actions.clearError} /> : null}

          {session && p && snapshot ? (
            <FeltStage
              status={
                <StatusStrip
                  session={session}
                  message={p.hiddenFrom ? null : session.message}
                  spinningSeq={p.spinningRound?.seq ?? null}
                  inPlaySeq={p.inPlayRound?.seq ?? null}
                  revealedSeq={p.revealedSeq}
                  decisionInFlight={snapshot.inFlight.decision}
                />
              }
              left={<RecentResultsPanel rounds={p.revealedRounds} spinningSeq={p.spinningRound?.seq ?? null} />}
              wheel={
                <RouletteWheel
                  spin={state.reveal.wheel}
                  speed={store.speed}
                  reducedMotion={store.reducedMotion}
                  onSettled={actions.onWheelSettled}
                  restingNumber={p.lastRound?.winningNumber ?? null}
                  className="drop-shadow-2xl"
                />
              }
              right={<LastRoundPanel round={p.lastRound} spinningSeq={p.spinningRound?.seq ?? null} />}
              table={table.tableProps ? <BettingTable {...table.tableProps} /> : null}
              feedback={
                <TableFeedback
                  roundError={table.roundError}
                  controlError={table.controlError}
                  draftMessage={table.draftMessage}
                  onDismiss={actions.clearError}
                />
              }
              controls={table.controlProps ? <ControlBar {...table.controlProps} /> : null}
            />
          ) : (
            <div className="felt-surface flex min-h-64 flex-col items-center justify-center gap-2 rounded-2xl p-6 text-center shadow-felt">
              <p className="m-0 text-lg font-semibold text-card">{COPY.brand}</p>
              <EmptyState onFelt>
                {state.busy.booting || state.busy.sessionLoading
                  ? 'Loading from the local server…'
                  : state.sessions.length
                    ? 'Choose a session in the header.'
                    : 'No sessions yet. Create one with “New session”.'}
              </EmptyState>
              <p className="m-0 font-mono text-[11px] text-champagne">{COPY.virtualOnly}</p>
            </div>
          )}

          <BottomDrawer
            open={drawer.open}
            onOpenChange={drawer.setOpen}
            tab={drawer.tab}
            onTab={drawer.setTab}
            counts={{ ledger: p?.revealedRounds.length ?? 0 }}
            panels={{
              logs: (
                <LogsDecisionsPanel
                  logs={d.visible.logs}
                  decisions={d.visible.decisions}
                  usageByDecision={d.usageByDecision}
                  heldBack={d.visible.heldBack}
                />
              ),
              chart: session && p ? (
                <BalanceChart rounds={p.revealedRounds} startingBalance={session.startingBalance} />
              ) : (
                <EmptyState>No session open.</EmptyState>
              ),
              ledger: session && p ? (
                <RoundLedger rounds={state.rounds} revealedSeq={p.revealedSeq} totalRounds={session.roundsPlayed} />
              ) : (
                <EmptyState>No session open.</EmptyState>
              ),
              history: (
                <SessionHistory
                  sessions={state.sessions}
                  providers={state.providers}
                  selectedId={state.selectedSessionId}
                  selectedBalance={p?.balance ?? null}
                  exportUrl={store.api.exportUrl}
                  onOpen={actions.selectSession}
                />
              ),
              raw: <RawJsonPanel decision={d.lastDecision} />,
              settings: (
                <SettingsPanel
                  form={d.settingsForm}
                  loaded={state.settings !== null}
                  saving={state.busy.settings}
                  error={state.lastError?.scope === 'settings' ? state.lastError : null}
                  onSave={(patch) => void actions.saveSettings(patch)}
                  suggestedPricingKey={d.suggestedPricingKey}
                />
              ),
            }}
          />
          <p className="m-0 text-center text-[11px] text-ink-muted">
            {COPY.virtualOnly} · {COPY.houseEdgeNote}
          </p>
        </main>
      </div>

      <NewSessionDialog
        open={d.dialog.open}
        onClose={d.dialog.close}
        form={d.newSessionForm}
        player={player}
        providers={state.providers}
        providerTests={state.providerTests}
        providerModels={state.providerModels}
        busy={state.busy}
        error={state.lastError?.scope === 'create' ? state.lastError : null}
        providerError={providerError}
        onCreate={(req) => void d.dialog.onCreate(req)}
        onTest={d.onTest}
        onLoadModels={d.onLoadModels}
      />
    </div>
  );
}

export default App;
