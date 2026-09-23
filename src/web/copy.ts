/**
 * Static interface copy. No data lives here — every number, model name and provider state shown in
 * the dashboard comes from the server. Labels for server enums are kept together so wording stays honest
 * and consistent (e.g. never calling the demo player "AI").
 */
import type {
  CostBasis,
  DecisionStatus,
  PauseReason,
  SessionEndReason,
  SessionMode,
  SessionPhase,
  SessionStatus,
  UsageAttemptStatus,
} from '../shared/contracts';

export const COPY = {
  brand: 'Luck — AI Roulette Lab',
  brandShort: 'Luck',
  simulationBadge: 'Virtual credits · Simulation',
  virtualOnly: 'Virtual credits only',
  notReported: 'Not reported',
  noValue: '—',
  newSession: 'New session',
  settings: 'Settings',
  sessionPicker: 'Session',
  noSessions: 'No sessions yet',
  sidebarToggle: 'Player & usage',
  spinning: 'Spinning…',
  inPlay: 'In play',
  demoTagline: 'rule-based, not AI',
  modelExplanationTitle: "Model's stated explanation (unverified)",
  modelExplanationNote:
    'Text the model returned alongside its bet. It is not evidence of how the decision was made and does not change the odds.',
  appBudgetTitle: 'App spending limit',
  appBudgetNote:
    'A limit enforced by this app before each paid request. It is not your provider account quota or balance.',
  providerQuotaTitle: 'Provider quota / rate limit',
  quotaNotReported: 'Not reported by this provider',
  localNoCharge: 'Local — no cloud inference charge',
  pricingAssumption: 'Assumption — verify current provider pricing',
  historyNotice: 'Historical results — labelled by round number. The current spin appears only after the ball rests.',
  houseEdgeNote: 'European single-zero roulette: every bet has a negative expected value for the player.',
} as const;

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  ready: 'Ready',
  running: 'Running',
  pause_requested: 'Pausing after this round',
  paused: 'Paused',
  stop_requested: 'Stopping',
  stopped: 'Stopped',
  completed: 'Completed',
};

export const PHASE_LABEL: Record<SessionPhase, string> = {
  ready: 'Waiting for bets',
  requesting_decision: 'Waiting for the player’s decision',
  committed: 'Bets committed — drawing outcome',
  outcome_recorded: 'Outcome recorded — settling',
  settled: 'Round settled',
};

export const PAUSE_REASON_LABEL: Record<PauseReason, string> = {
  user_pause: 'Paused by you',
  step_complete: 'Single round complete',
  provider_error: 'Paused: provider error',
  invalid_output: 'Paused: invalid model output',
  rate_limited: 'Paused: rate limited by provider',
  server_restart: 'Paused: server restarted',
};

export const END_REASON_LABEL: Record<SessionEndReason, string> = {
  user_stop: 'Stopped by you',
  max_rounds: 'Round limit reached',
  max_runtime: 'Runtime limit reached',
  budget_exhausted: 'App spending limit reached',
  insufficient_balance: 'Balance too low for the minimum stake',
  model_stop: 'The player chose to stop',
};

export const MODE_LABEL: Record<SessionMode, string> = {
  manual: 'Manual',
  demo: 'Demo',
  ai: 'AI',
};

export const DECISION_STATUS_LABEL: Record<DecisionStatus, string> = {
  pending: 'Waiting for response',
  accepted: 'Accepted',
  invalid: 'Rejected: invalid output',
  failed: 'Failed',
  stale: 'Discarded (stale)',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted by restart',
  blocked_budget: 'Not sent: app spending limit',
};

export const USAGE_STATUS_LABEL: Record<UsageAttemptStatus, string> = {
  ok: 'OK',
  error: 'Error',
  timeout: 'Timeout',
  rate_limited: 'Rate limited',
  invalid_output: 'Invalid output',
  cancelled: 'Cancelled',
  stale: 'Stale',
};

export const COST_BASIS_LABEL: Record<CostBasis, string> = {
  'provider-reported': 'Reported by the provider tool (its own estimate)',
  'estimated-from-pricing': 'Estimated from tokens × pricing assumption',
  'local-no-charge': 'Local — no cloud inference charge',
  unknown: 'Unknown — usage or pricing not reported',
  'not-applicable': 'Not applicable',
};

export const DRAWER_TAB_LABEL = {
  logs: 'Logs & decisions',
  chart: 'Balance chart',
  ledger: 'Round ledger',
  history: 'Session history',
  raw: 'Raw JSON',
  settings: 'Settings',
} as const;

export type DrawerTab = keyof typeof DRAWER_TAB_LABEL;
export const DRAWER_TABS = Object.keys(DRAWER_TAB_LABEL) as DrawerTab[];

/** Why a measurement can be missing — used as tooltip text next to "Not reported". */
export const MISSING_REASON = {
  noRequests: 'No model requests in this session yet.',
  noTokenUsage: 'This provider does not report token usage.',
  inputOnly: 'This provider reports input tokens only.',
  latencyUnknown: 'The last request ended without a measured latency (e.g. cancelled or crashed).',
  speedUnknown: 'Output speed needs reported output tokens and a measured duration.',
  quota: 'The provider did not send rate-limit or quota information with its responses.',
  quotaNever: 'This provider does not expose quota or rate-limit information.',
  budgetNone: 'No app spending limit is set for this session. Paid providers will refuse to start.',
  notAi: 'This session is not played by an AI model, so there is no model usage.',
  latestDecisionNone: 'No decision has been requested yet.',
} as const;

export const LIMIT_FIELD_COPY = {
  startingBalance: { label: 'Starting balance', hint: 'Virtual credits' },
  minStake: { label: 'Minimum stake', hint: 'Per bet' },
  stakeIncrement: { label: 'Stake increment', hint: 'Stakes must be a multiple of this' },
  maxStakePerBet: { label: 'Max stake per bet', hint: 'Per position' },
  maxStakePerRound: { label: 'Max stake per round', hint: 'All bets combined' },
  maxBetsPerRound: { label: 'Max bets per round', hint: 'Positions' },
  maxRounds: { label: 'Max rounds', hint: 'Blank = unlimited' },
  maxRuntimeMin: { label: 'Max autonomous runtime', hint: 'Minutes · blank = unlimited' },
  budgetUsd: { label: 'App spending limit (USD)', hint: 'Paid providers only · blank = none (paid providers refuse to start)' },
  maxOutputTokens: { label: 'Max output tokens', hint: 'Per model request' },
  decisionTimeoutSec: { label: 'Decision timeout', hint: 'Seconds per attempt' },
  maxRetries: { label: 'Retries per decision', hint: 'After the first attempt' },
  maxConsecutiveFailures: { label: 'Failures before pausing', hint: 'Consecutive failed decisions' },
  historyWindow: { label: 'History shown to the player', hint: 'Completed rounds' },
} as const;
