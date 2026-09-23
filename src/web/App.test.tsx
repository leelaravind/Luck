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
import { fixtureRound, fixtureSession, fixtureSnapshot, fixtureUsage, FIXTURE_SESSION_ID } from './state/testFixtures';

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
  /** Response for POST /rounds (default 404). */
  roundResponse?: { status: number; body: unknown };
  posts?: string[];
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
    if (url === '/api/settings') return json(world.settings);
    if (url === '/api/sessions' && method === 'GET') return json({ sessions: world.sessions });
    const id = FIXTURE_SESSION_ID;
    if (url === `/api/sessions/${id}`) return json(world.snapshot);
    if (url.startsWith(`/api/sessions/${id}/rounds`)) return json({ rounds: world.rounds });
    if (url.startsWith(`/api/sessions/${id}/decisions`)) return json({ decisions: [] });
    if (url.startsWith(`/api/sessions/${id}/logs`)) return json({ logs: [] });
    if (url.startsWith(`/api/sessions/${id}/usage`)) return json({ records: world.usage, summary: world.snapshot.usage });
    return json({ error: { code: 'not_found', message: `No fixture for ${method} ${url}` } }, 404);
  }) as unknown as typeof fetch;
}

const SETTINGS: AppSettings = {
  defaultLimits: DEFAULT_LIMITS,
  animationSpeed: 'normal',
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
    await waitFor(() => expect((spin as HTMLButtonElement).disabled).toBe(false));
    act(() => {
      fireEvent.click(spin);
      fireEvent.click(spin);
    });
    const alert = await within(screen.getByRole('main')).findByRole('alert');
    expect(alert.textContent).toContain('The server rejected these bets: Stake above the per-bet maximum');
    expect(alert.textContent).toContain('straight:17 exceeds V$ 100.00');
    expect(world.posts!.filter((p) => p.endsWith('/rounds'))).toHaveLength(1);
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
