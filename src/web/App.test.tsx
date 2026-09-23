// @vitest-environment jsdom
/**
 * App smoke + reveal integration tests. FIXTURE DATA ONLY: fetch and EventSource are mocked; no server,
 * no provider and no network are involved. The wheel is replaced by a test double so the test controls
 * exactly when onSettled fires.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSettings,
  AppSettingsPatch,
  DecisionRecord,
  ProviderStatus,
  RoundRecord,
  ServerEvent,
  SessionInfo,
  SessionSnapshot,
  UsageRecord,
} from '../shared/contracts';
import { DEFAULT_LIMITS } from '../shared/contracts';
import type { RouletteWheelProps } from './contracts';
import { createApiClient } from './api/client';
import { App } from './App';
import {
  fixtureDecision,
  fixtureRound,
  fixtureSession,
  fixtureSnapshot,
  fixtureUsage,
  fixtureUsageRecord,
  FIXTURE_SESSION_ID,
} from './state/testFixtures';

// Wheel test double: shows the spin it was given and settles only when the test clicks.
vi.mock('./components/wheel/RouletteWheel', () => ({
  RouletteWheel: ({ spin, reducedMotion, onSettled }: RouletteWheelProps) => (
    <div data-testid="wheel" data-spin={spin?.roundId ?? ''} data-reduced={String(reducedMotion)}>
      <button type="button" onClick={() => spin && onSettled(spin.roundId)}>
        settle wheel
      </button>
    </div>
  ),
}));

// ───────────── EventSource fake ─────────────
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  emit(ev: ServerEvent) {
    const e = new MessageEvent('message', { data: JSON.stringify(ev) });
    this.listeners.get('message')?.forEach((fn) => fn(e));
  }
}

// ───────────── fetch fake ─────────────
interface World {
  providers: ProviderStatus[];
  settings: AppSettings;
  sessions: SessionInfo[];
  snapshot: SessionSnapshot;
  rounds: RoundRecord[];
  usage: UsageRecord[];
  decisions?: DecisionRecord[];
  /** Response for POST /rounds (default 404). */
  roundResponse?: { status: number; body: unknown };
  posts?: string[];
  /** Bodies of PUT /api/settings (the fixture applies them to `settings` like the server contract). */
  settingsPuts?: unknown[];
  /** Number of GET /api/settings requests. */
  settingsGets?: number;
  /** Number of GET /api/sessions requests. */
  sessionListGets?: number;
}

function makeFetch(world: World) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (method !== 'GET') world.posts?.push(`${method} ${url}`);
    if (method === 'POST' && url.endsWith('/rounds') && world.roundResponse) {
      await new Promise((r) => setTimeout(r, 20)); // keep the request in flight briefly
      return json(world.roundResponse.body, world.roundResponse.status);
    }
    if (url === '/api/health') return json({ ok: true, version: 'test' });
    if (url === '/api/providers') return json({ providers: world.providers });
    if (url === '/api/settings' && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as AppSettingsPatch;
      world.settingsPuts?.push(body);
      // The AppSettingsPatch contract: pricing entries are MERGED key by key; deletions only through
      // pricingRemove; built-in keys are never removed; builtInPricingKeys is read-only.
      const { pricing, pricingRemove, builtInPricingKeys: _readOnly, ...rest } = body;
      const builtIn = new Set(world.settings.builtInPricingKeys ?? []);
      const nextPricing = { ...world.settings.pricing, ...(pricing ?? {}) };
      for (const key of pricingRemove ?? []) if (!builtIn.has(key)) delete nextPricing[key];
      world.settings = { ...world.settings, ...rest, pricing: nextPricing };
      return json(world.settings);
    }
    if (url === '/api/settings') {
      world.settingsGets = (world.settingsGets ?? 0) + 1;
      return json(world.settings);
    }
    if (url === '/api/sessions' && method === 'GET') {
      world.sessionListGets = (world.sessionListGets ?? 0) + 1;
      return json({ sessions: world.sessions });
    }
    const id = FIXTURE_SESSION_ID;
    if (url === `/api/sessions/${id}`) return json(world.snapshot);
    if (url.startsWith(`/api/sessions/${id}/rounds`)) return json({ rounds: world.rounds });
    if (url.startsWith(`/api/sessions/${id}/decisions`)) return json({ decisions: world.decisions ?? [] });
    if (url.startsWith(`/api/sessions/${id}/logs`)) return json({ logs: [] });
    if (url.startsWith(`/api/sessions/${id}/usage`)) return json({ records: world.usage, summary: world.snapshot.usage });
    return json({ error: { code: 'not_found', message: `No fixture for ${method} ${url}` } }, 404);
  }) as unknown as typeof fetch;
}

const SETTINGS: AppSettings = {
  defaultLimits: DEFAULT_LIMITS,
  animationSpeed: 'normal',
  roundPacingMs: 7000,
  reduceMotion: 'off',
  pricing: {},
  players: {},
};

const OLLAMA: ProviderStatus = {
  kind: 'ollama',
  capabilities: {
    kind: 'ollama',
    label: 'Ollama (fixture)',
    local: true,
    paid: false,
    generatesText: true,
    reportsTokenUsage: 'full',
    reportsCost: false,
    listsModels: true,
    structuredOutput: true,
    quotaInfo: 'none',
    requiresApiKey: false,
    notes: [],
  },
  configured: true,
  enabled: true,
  issues: [],
  defaults: { baseUrl: 'http://127.0.0.1:11434' },
  lastTest: null,
};

const OPENAI: ProviderStatus = {
  kind: 'openai',
  capabilities: {
    kind: 'openai',
    label: 'OpenAI-compatible (fixture)',
    local: false,
    paid: true,
    generatesText: true,
    reportsTokenUsage: 'full',
    reportsCost: false,
    listsModels: true,
    structuredOutput: true,
    quotaInfo: 'rate-limit-headers',
    requiresApiKey: true,
    notes: [],
  },
  configured: false,
  enabled: false,
  issues: ['No API key configured (fixture)'],
  defaults: {},
  lastTest: null,
};

function unknownUsageRecord(): UsageRecord {
  return {
    id: 'u1',
    sessionId: FIXTURE_SESSION_ID,
    decisionId: 'd1',
    attempt: 1,
    providerKind: 'openai',
    model: 'fixture-model',
    status: 'timeout',
    latencyMs: null,
    generationMs: null,
    outputTokensPerSec: null,
    costMicros: null,
    costBasis: 'unknown',
    rateLimit: null,
    createdAt: '2026-09-23T10:00:05.000Z',
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    known: false,
  };
}

function lastSource(): FakeEventSource {
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!es) throw new Error('no EventSource opened');
  return es;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App (fixture server)', () => {
  it('renders the single sidebar, the wheel region and the table region, with honest "Not reported" usage', async () => {
    const r1 = fixtureRound(1, { balanceBefore: 1_000_00 });
    const session = fixtureSession({
      mode: 'ai',
      player: { kind: 'openai', model: 'fixture-model' },
      balance: r1.balanceAfter!,
      roundsPlayed: 1,
    });
    const usage = fixtureUsage({
      requests: 1,
      failedRequests: 1,
      unknownUsageRequests: 1,
      costBasis: 'unknown',
      budgetMicros: 250_000,
      budgetRemainingMicros: 250_000,
      lastLatencyMs: null,
      avgLatencyMs: null,
      lastOutputTokensPerSec: null,
      lastRateLimit: null,
    });
    const world: World = {
      providers: [OLLAMA, OPENAI],
      settings: SETTINGS,
      sessions: [session],
      snapshot: fixtureSnapshot(session, [r1], { usage }),
      rounds: [r1],
      usage: [unknownUsageRecord()],
    };
    render(<App api={createApiClient({ fetch: makeFetch(world) })} />);

    const sidebar = await screen.findByRole('complementary', { name: 'Player and usage' });
    expect(screen.getAllByRole('complementary')).toHaveLength(1); // exactly ONE sidebar
    const brand = screen.getByRole('heading', { level: 1, name: 'Luck — AI Roulette Lab' });
    expect(brand.closest('header')?.parentElement?.closest('header, main, aside, section')).toBeNull(); // page banner
    expect(screen.getByRole('navigation', { name: 'Sessions' })).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    await screen.findByRole('region', { name: 'Roulette wheel' });
    expect(screen.getByRole('region', { name: 'Betting table' })).toBeTruthy();
    expect(screen.getByTestId('wheel')).toBeTruthy();

    // Providers come from the server with honest availability badges.
    expect(within(sidebar).getByText('Ollama (fixture)')).toBeTruthy();
    expect(within(sidebar).getAllByText('Configured (untested)').length).toBeGreaterThan(0);
    expect(within(sidebar).getByText('Not configured')).toBeTruthy();
    expect(within(sidebar).getByText('rule-based, not AI')).toBeTruthy();

    // Usage the provider never reported is shown as "Not reported", never as a number.
    expect(within(sidebar).getAllByText('Not reported').length).toBeGreaterThanOrEqual(3);
    expect(within(sidebar).getByText('Not reported by this provider')).toBeTruthy();
    expect(within(sidebar).getByText('App spending limit')).toBeTruthy();
    expect(within(sidebar).getByText('Provider quota / rate limit')).toBeTruthy();

    // No invented telemetry from the reference design.
    const text = document.body.textContent ?? '';
    for (const banned of ['FPS', 'WebSocket', 'Kelly', 'Confidence', 'Hot Pockets', 'Sector Density', 'System Load']) {
      expect(text).not.toContain(banned);
    }
    expect(text).toContain('Virtual credits');
  });

  it('keeps a new result hidden until the wheel settles, then reveals and announces it', async () => {
    const r1 = fixtureRound(1, { balanceBefore: 1_000_00, winningNumber: 5 });
    const session = fixtureSession({ balance: r1.balanceAfter!, roundsPlayed: 1 });
    const world: World = {
      providers: [],
      settings: SETTINGS,
      sessions: [session],
      snapshot: fixtureSnapshot(session, [r1]),
      rounds: [r1],
      usage: [],
    };
    render(<App api={createApiClient({ fetch: makeFetch(world) })} />);
    const lastRound = await screen.findByRole('region', { name: 'Last round' });
    await waitFor(() => expect(within(lastRound).getByText('Round #1')).toBeTruthy());
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const es = lastSource();
    expect(es.url).toBe(`/api/events?sessionId=${FIXTURE_SESSION_ID}`);
    act(() => es.open());

    // Server settles round 2 (a win on 17) and pushes it.
    const r2 = fixtureRound(2, { balanceBefore: r1.balanceAfter!, winningNumber: 17, betNumber: 17 });
    const s2 = { ...session, balance: r2.balanceAfter!, roundsPlayed: 2, updatedAt: '2026-09-23T10:10:00.000Z' };
    act(() => {
      es.emit({ type: 'round', round: r2 });
      es.emit({ type: 'snapshot', snapshot: fixtureSnapshot(s2, [r1, r2]) });
    });

    expect(screen.getByTestId('wheel').getAttribute('data-spin')).toBe('round-2');
    expect(within(lastRound).getByText('Round #1')).toBeTruthy();
    expect(within(lastRound).queryByText('Round #2')).toBeNull();
    expect(within(lastRound).getByText(/Round #2: Spinning/)).toBeTruthy();
    expect(screen.getByTestId('live-region').textContent).toBe('');
    const recent = screen.getByRole('region', { name: 'Recent results' });
    expect(within(recent).queryByLabelText('Round 2: 17')).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'settle wheel' }));
    });

    expect(within(lastRound).getByText('Round #2')).toBeTruthy();
    expect(within(recent).getByLabelText('Round 2: 17')).toBeTruthy();
    expect(screen.getByTestId('live-region').textContent).toContain('Round 2: 17 black');
    // 990.00 before the round − 10.00 stake + 360.00 returned (35:1 + stake) = 1,340.00, as settled by the fixture.
    expect(screen.getByTestId('live-region').textContent).toContain('Balance V$ 1,340.00');
  });

  it('reveals immediately when reduced motion is on', async () => {
    const r1 = fixtureRound(1, { balanceBefore: 1_000_00 });
    const session = fixtureSession({ balance: r1.balanceAfter!, roundsPlayed: 1 });
    const world: World = {
      providers: [],
      settings: { ...SETTINGS, reduceMotion: 'on' },
      sessions: [session],
      snapshot: fixtureSnapshot(session, [r1]),
      rounds: [r1],
      usage: [],
    };
    render(<App api={createApiClient({ fetch: makeFetch(world) })} />);
    const lastRound = await screen.findByRole('region', { name: 'Last round' });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const es = lastSource();
    act(() => es.open());
    expect(screen.getByTestId('wheel').getAttribute('data-reduced')).toBe('true');

    const r2 = fixtureRound(2, { balanceBefore: r1.balanceAfter!, winningNumber: 0 });
    act(() => es.emit({ type: 'round', round: r2 }));

    // No click on the wheel: the result is visible at once, and the wheel still gets the spin to rest on.
    expect(within(lastRound).getByText('Round #2')).toBeTruthy();
    expect(within(lastRound).queryByText(/Spinning/)).toBeNull();
    expect(screen.getByTestId('wheel').getAttribute('data-spin')).toBe('round-2');
  });

  it('sends one manual round per click burst and shows the server validation error near the table', async () => {
    const session = fixtureSession();
    const world: World = {
      providers: [],
      settings: SETTINGS,
      sessions: [session],
      snapshot: fixtureSnapshot(session, []),
      rounds: [],
      usage: [],
      posts: [],
      roundResponse: { status: 422, body: { error: { code: 'limit_exceeded', message: 'Stake above the per-bet maximum', details: ['straight:17 exceeds V$ 100.00'] } } },
    };
    render(<App api={createApiClient({ fetch: makeFetch(world) })} />);
    const table = await screen.findByRole('region', { name: 'Betting table' });
    const cell = await within(table).findByRole('button', { name: /^Straight 17\b/ });
    fireEvent.click(cell);
    const spin = await screen.findByRole('button', { name: /^Spin/ });
    await waitFor(() => expect(spin.getAttribute('aria-disabled')).toBeNull());
    spin.focus();
    act(() => {
      fireEvent.click(spin);
      fireEvent.click(spin);
    });
    // While the request is in flight Spin is unavailable via aria-disabled only, so it keeps focus (#25).
    expect(spin.getAttribute('aria-disabled')).toBe('true');
    expect((spin as HTMLButtonElement).disabled).toBe(false);
    const alert = await within(screen.getByRole('main')).findByRole('alert');
    expect(alert.textContent).toContain('The server rejected these bets: Stake above the per-bet maximum');
    expect(alert.textContent).toContain('straight:17 exceeds V$ 100.00');
    expect(world.posts!.filter((p) => p.endsWith('/rounds'))).toHaveLength(1);
    expect(document.activeElement).toBe(spin);
  });

  it('shows an empty state (no invented data) when there are no sessions', async () => {
    const session = fixtureSession();
    const world: World = {
      providers: [],
      settings: SETTINGS,
      sessions: [],
      snapshot: fixtureSnapshot(session, []),
      rounds: [],
      usage: [],
    };
    render(<App api={createApiClient({ fetch: makeFetch(world) })} />);
    expect(await screen.findByText('No sessions yet. Create one with “New session”.')).toBeTruthy();
    expect(screen.getByText('Select or create a session to see usage.')).toBeTruthy();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('opens the new-session dialog, closes it with Escape and supports keyboard tabs in the drawer', async () => {
    const world: World = {
      providers: [],
      settings: SETTINGS,
      sessions: [],
      snapshot: fixtureSnapshot(fixtureSession(), []),
      rounds: [],
      usage: [],
    };
    render(<App api={createApiClient({ fetch: makeFetch(world) })} />);
    await screen.findByText('No sessions yet. Create one with “New session”.');

    fireEvent.click(screen.getAllByRole('button', { name: /New session/ })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    // Limits are prefilled from the saved defaults (V$ 1,000 starting balance).
    expect(within(dialog).getByLabelText('Starting balance')).toHaveProperty('value', '1000.00');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Logs & decisions'), expect.stringContaining('Settings')]),
    );
    fireEvent.click(tabs[0]!);
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /Balance chart/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tab', { name: /Balance chart/ }), { key: 'End' });
    expect(screen.getByRole('tab', { name: /Settings/ }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('App audit fixes (fixture server)', () => {
  it('instant speed: the result stays hidden until the wheel reports the ball placed (#24)', async () => {
    const r1 = fixtureRound(1, { balanceBefore: 1_000_00 });
    const session = fixtureSession({ balance: r1.balanceAfter!, roundsPlayed: 1 });
    const world: World = {
      providers: [],
      settings: { ...SETTINGS, animationSpeed: 'instant' },
      sessions: [session],
      snapshot: fixtureSnapshot(session, [r1]),
      rounds: [r1],
      usage: [],
    };
    render(<App api={createApiClient({ fetch: makeFetch(world) })} />);
    const lastRound = await screen.findByRole('region', { name: 'Last round' });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const es = lastSource();
    act(() => es.open());

    const r2 = fixtureRound(2, { balanceBefore: r1.balanceAfter!, winningNumber: 17, betNumber: 17 });
    act(() => es.emit({ type: 'round', round: r2 }));
    // The wheel receives the spin, but nothing is revealed before it reports the ball in the pocket.
    expect(screen.getByTestId('wheel').getAttribute('data-spin')).toBe('round-2');
    expect(within(lastRound).queryByText('Round #2')).toBeNull();
    expect(screen.getByTestId('live-region').textContent).toBe('');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'settle wheel' }));
    });
    expect(within(lastRound).getByText('Round #2')).toBeTruthy();
    expect(screen.getByTestId('live-region').textContent).toContain('Round 2: 17 black');
  });

  it('shows per-attempt usage and the provider note for decisions (#5, #29)', async () => {
    const r1 = fixtureRound(1, { balanceBefore: 1_000_00 });
    const session = fixtureSession({
      mode: 'ai',
      player: { kind: 'openai', model: 'fixture-model' },
      balance: r1.balanceAfter!,
      roundsPlayed: 1,
    });
    const decision = fixtureDecision({ attempts: 2, latencyMs: 2_000, providerNote: 'conversation c-1 · turn 2 (resumed)' });
    const usage = [
      fixtureUsageRecord({
        id: 'u-1',
        attempt: 1,
        status: 'timeout',
        known: false,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        costMicros: null,
        costBasis: 'unknown',
        latencyMs: null,
        createdAt: '2026-09-23T10:00:02.500Z',
      }),
      fixtureUsageRecord({ id: 'u-2', attempt: 2, inputTokens: 1_200, outputTokens: 80, cacheReadTokens: 1_000, costMicros: 1_234, latencyMs: 1_500 }),
      // Another decision's record must not be attributed to this one.
      fixtureUsageRecord({ id: 'u-x', decisionId: 'other-decision', inputTokens: 999_999 }),
    ];
    const world: World = {
      providers: [OPENAI],
      settings: SETTINGS,
      sessions: [session],
      snapshot: fixtureSnapshot(session, [r1], {
        lastDecision: decision,
        usage: fixtureUsage({ requests: 3, costBasis: 'estimated-from-pricing' }),
      }),
      rounds: [r1],
      usage,
      decisions: [decision],
    };
    render(<App api={createApiClient({ fetch: makeFetch(world) })} />);

    const heading = await screen.findByRole('heading', { name: 'Latest decision' });
    const card = heading.closest('section')!;
    await waitFor(() => expect(within(card).getByText('Attempt 2')).toBeTruthy());
    const attempts = within(card)
      .getAllByRole('listitem')
      .filter((li) => /^Attempt \d/.test(li.textContent ?? ''));
    expect(attempts).toHaveLength(2);
    const [a1, a2] = attempts as [HTMLElement, HTMLElement];
    // Attempt 1: nothing reported → "Not reported" for tokens, cost and latency; status from USAGE_STATUS_LABEL.
    expect(within(a1).getByText('Timeout')).toBeTruthy();
    expect(within(a1).getAllByText('Not reported')).toHaveLength(5);
    // Attempt 2: the reported figures, the cost with its basis, and the attempt latency.
    expect(within(a2).getByText('OK')).toBeTruthy();
    expect(within(a2).getByText('1,200')).toBeTruthy();
    expect(within(a2).getByText('80')).toBeTruthy();
    expect(within(a2).getByText('1,000')).toBeTruthy();
    expect(within(a2).getByText('$0.0012')).toBeTruthy();
    expect(within(a2).getByText('(estimate from pricing assumption)')).toBeTruthy();
    expect(within(a2).getByText('1.50 s')).toBeTruthy();
    expect(within(card).queryByText('999,999')).toBeNull();
    // Provider note, labelled as coming from the adapter.
    expect(within(card).getByText('Provider note (adapter, not the model)')).toBeTruthy();
    expect(within(card).getByText('conversation c-1 · turn 2 (resumed)')).toBeTruthy();

    // The decisions log shows the same, per decision.
    fireEvent.click(screen.getByRole('tab', { name: /Logs & decisions/ }));
    const log = screen.getByRole('heading', { name: 'Decisions' }).closest('section')!;
    await waitFor(() => expect(within(log).getByText('Attempt 2')).toBeTruthy());
    expect(within(log).getByText('1,200')).toBeTruthy();
    expect(within(log).getByText('$0.0012')).toBeTruthy();
    expect(within(log).getByText('Timeout')).toBeTruthy();
    expect(within(log).getByText('Provider note (adapter, not the model):')).toBeTruthy();
    expect(within(log).getByText('conversation c-1 · turn 2 (resumed)')).toBeTruthy();
    expect(within(log).queryByText('999,999')).toBeNull();
  });

  it('refreshes the session list on window focus, picker focus, the history tab and a status change (#26)', async () => {
    const session = fixtureSession({ mode: 'demo', player: { kind: 'demo' } });
    const world: World = {
      providers: [],
      settings: SETTINGS,
      sessions: [session],
      snapshot: fixtureSnapshot(session, []),
      rounds: [],
      usage: [],
    };
    render(<App api={createApiClient({ fetch: makeFetch(world) })} />);
    const nav = await screen.findByRole('navigation', { name: 'Sessions' });
    const picker = within(nav).getByRole('combobox', { name: 'Session' });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const made = (id: string, name: string) =>
      fixtureSession({ id, name, createdAt: '2026-09-23T11:00:00.000Z', updatedAt: '2026-09-23T11:00:00.000Z' });
    const hasOption = (name: string) =>
      within(picker)
        .queryAllByRole('option')
        .some((o) => o.textContent?.startsWith(name));

    // 1. Window regains focus.
    world.sessions = [...world.sessions, made('s-focus', 'Made in another tab')];
    expect(hasOption('Made in another tab')).toBe(false);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(hasOption('Made in another tab')).toBe(true));

    // 2. The header picker is focused (about to open).
    world.sessions = [...world.sessions, made('s-picker', 'Made via the API')];
    act(() => {
      fireEvent.focus(picker);
    });
    await waitFor(() => expect(hasOption('Made via the API')).toBe(true));

    // 3. The Session history tab is opened.
    world.sessions = [...world.sessions, made('s-history', 'Made for history')];
    fireEvent.click(screen.getByRole('tab', { name: /Session history/ }));
    await waitFor(() => expect(screen.getByRole('tabpanel').textContent).toContain('Made for history'));

    // 4. The open session's status changes (here: pushed over the event stream).
    const es = lastSource();
    act(() => es.open());
    world.sessions = [...world.sessions, made('s-status', 'Made while running')];
    const before = world.sessionListGets ?? 0;
    act(() =>
      es.emit({
        type: 'snapshot',
        snapshot: fixtureSnapshot({ ...session, status: 'running', updatedAt: '2026-09-23T10:05:00.000Z' }, []),
      }),
    );
    await waitFor(() => expect(hasOption('Made while running')).toBe(true));
    expect(world.sessionListGets).toBeGreaterThan(before);
    // The open session keeps its live status from the stream.
    expect(within(picker).getByRole('option', { name: /Fixture session · Running/ })).toBeTruthy();
  });

  it('settings: pause between rounds is saved as roundPacingMs, hints are accurate, only changed fields are sent (#4)', async () => {
    const world: World = {
      providers: [],
      settings: SETTINGS,
      sessions: [],
      snapshot: fixtureSnapshot(fixtureSession(), []),
      rounds: [],
      usage: [],
      settingsPuts: [],
    };
    render(<App api={createApiClient({ fetch: makeFetch(world) })} />);
    await screen.findByText('No sessions yet. Create one with “New session”.');
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    const pacing = (await screen.findByLabelText('Pause between autonomous rounds (seconds)')) as HTMLInputElement;
    expect(pacing.value).toBe('7');
    const text = document.body.textContent ?? '';
    expect(text).toContain('This sets how often models are called');
    expect(text).toContain(
      'Changes only the wheel animation. How often models are asked is set by the pause between autonomous rounds below.',
    );
    expect(text).not.toContain('does not change how often');

    // Invalid pause: error shown, save blocked.
    fireEvent.change(pacing, { target: { value: 'soon' } });
    expect(screen.getByText(/Enter seconds from 0 to 600/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(pacing, { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(world.settingsPuts).toHaveLength(1));
    // Only what changed: no limits, display fields or pricing map ride along.
    expect(world.settingsPuts![0]).toEqual({ roundPacingMs: 2500 });
    await waitFor(() =>
      expect((screen.getByLabelText('Pause between autonomous rounds (seconds)') as HTMLInputElement).value).toBe('2.5'),
    );

    // An unchanged pause is not re-sent on the next save.
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(world.settingsPuts).toHaveLength(2));
    expect(world.settingsPuts![1]).not.toHaveProperty('roundPacingMs');
  });

  it('settings pricing: Remove is offered by key (not source), is sent as pricingRemove, and a removed row stays removed after reload (#36)', async () => {
    const world: World = {
      providers: [],
      settings: {
        ...SETTINGS,
        pricing: {
          'openai:default-model': { inputPerMTokUsd: 1, outputPerMTokUsd: 2, source: 'default-assumption', asOf: '2026-01-01' },
          'anthropic:my-model': { inputPerMTokUsd: 3, outputPerMTokUsd: 15, source: 'user', asOf: '2026-09-01' },
          // A default-assumption row whose key is not a built-in default (e.g. left by an older version).
          'openai:orphan-fixture-default': { inputPerMTokUsd: 4, outputPerMTokUsd: 8, source: 'default-assumption', asOf: '2025-01-01' },
        },
        builtInPricingKeys: ['openai:default-model'],
      },
      sessions: [],
      snapshot: fixtureSnapshot(fixtureSession(), []),
      rounds: [],
      usage: [],
      settingsPuts: [],
    };
    const api = createApiClient({ fetch: makeFetch(world) });
    render(<App api={api} />);
    await screen.findByText('No sessions yet. Create one with “New session”.');
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await screen.findByText('openai:orphan-fixture-default', { selector: 'legend' });

    // The built-in row has no Remove; the user row and the orphan default-assumption row do.
    const removeButtons = screen.getAllByRole('button', { name: /^Remove/ });
    expect(removeButtons.map((b) => b.getAttribute('aria-label'))).toEqual(['Remove anthropic:my-model', 'Remove openai:orphan-fixture-default']);
    expect(screen.queryByRole('button', { name: 'Remove openai:default-model' })).toBeNull();
    expect(screen.getByText('default assumption (not built in)')).toBeTruthy();
    expect(screen.getByText(/Built-in default assumptions come with the app and cannot be removed/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove anthropic:my-model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove openai:orphan-fixture-default' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(world.settingsPuts).toHaveLength(1));
    // Explicit deletions, no complete map (and never the read-only builtInPricingKeys).
    expect(world.settingsPuts![0]).toEqual({ pricingRemove: ['anthropic:my-model', 'openai:orphan-fixture-default'] });
    expect(Object.keys(world.settings.pricing)).toEqual(['openai:default-model']);
    await waitFor(() => expect(screen.queryByText('anthropic:my-model')).toBeNull());
    expect(screen.queryByText('openai:orphan-fixture-default')).toBeNull();
    expect(screen.getByText('openai:default-model')).toBeTruthy();

    // Reload the page: the removed rows stay removed; the built-in row is still listed, still without Remove.
    cleanup();
    render(<App api={createApiClient({ fetch: makeFetch(world) })} />);
    await screen.findByText('openai:default-model', { selector: 'legend' }); // the drawer re-opens on Settings (remembered per browser)
    expect(screen.queryByText('anthropic:my-model')).toBeNull();
    expect(screen.queryByText('openai:orphan-fixture-default')).toBeNull();
    expect(screen.queryAllByRole('button', { name: /^Remove/ })).toHaveLength(0);
  });

  it('settings freshness: opening the panel re-reads the settings, and a stale tab cannot overwrite what it did not change', async () => {
    const mine = { inputPerMTokUsd: 3, outputPerMTokUsd: 15, source: 'user' as const, asOf: '2026-09-01' };
    const world: World = {
      providers: [],
      settings: { ...SETTINGS, pricing: { 'anthropic:my-model': mine } },
      sessions: [],
      snapshot: fixtureSnapshot(fixtureSession(), []),
      rounds: [],
      usage: [],
      settingsPuts: [],
    };
    render(<App api={createApiClient({ fetch: makeFetch(world) })} />);
    await screen.findByText('No sessions yet. Create one with “New session”.');
    const loads = world.settingsGets ?? 0;
    expect(loads).toBe(1); // the bootstrap read

    // Another tab (or an API client) adds a row after this tab loaded. Opening Settings re-reads them.
    const other = { inputPerMTokUsd: 1, outputPerMTokUsd: 1, source: 'user' as const, asOf: '2026-09-20' };
    world.settings = { ...world.settings, pricing: { ...world.settings.pricing, 'openai:other-tab-fixture': other } };
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await screen.findByText('openai:other-tab-fixture', { selector: 'legend' });
    expect(world.settingsGets).toBe(loads + 1);

    // With unsaved edits, a focus does not re-read (the edits would be replaced)...
    const pacing = screen.getByLabelText('Pause between autonomous rounds (seconds)') as HTMLInputElement;
    fireEvent.change(pacing, { target: { value: '3' } });
    const later = { inputPerMTokUsd: 2, outputPerMTokUsd: 2, source: 'user' as const, asOf: '2026-09-21' };
    world.settings = {
      ...world.settings,
      animationSpeed: 'fast',
      pricing: { ...world.settings.pricing, 'ollama:later-fixture': later },
    };
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(world.settingsGets).toBe(loads + 1);
    expect(pacing.value).toBe('3');
    expect(screen.queryByText('ollama:later-fixture')).toBeNull();

    // ...and the save sends only that edit: the row and the speed saved elsewhere survive.
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(world.settingsPuts).toHaveLength(1));
    expect(world.settingsPuts![0]).toEqual({ roundPacingMs: 3000 });
    expect(Object.keys(world.settings.pricing).sort()).toEqual(['anthropic:my-model', 'ollama:later-fixture', 'openai:other-tab-fixture']);
    expect(world.settings.animationSpeed).toBe('fast');
    // The save's response brings the form up to date.
    await screen.findByText('ollama:later-fixture', { selector: 'legend' });

    // Nothing unsaved now: a focus re-reads the settings.
    world.settings = { ...world.settings, pricing: { ...world.settings.pricing, 'anthropic:focus-fixture': later } };
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await screen.findByText('anthropic:focus-fixture', { selector: 'legend' });
    expect(world.settingsGets).toBe(loads + 2);
  });
});
