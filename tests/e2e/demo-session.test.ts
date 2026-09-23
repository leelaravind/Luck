/**
 * E2E — rule-based demo player over HTTP (real app + service + SQLite; FIXTURE outcome sequence).
 *
 * Proves: Start runs exactly maxRounds settled rounds and completes with endReason max_rounds; every
 * decision is labelled as the demo player; repeated Start clicks never create a second runner;
 * Pause / Next Round (step) / Stop have their documented semantics; the SSE stream (real TCP listen on
 * an ephemeral port + fetch) delivers snapshot and round events.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecisionRecord, RoundRecord, ServerEvent, SessionSnapshot } from '../../src/shared/contracts.js';
import type { SessionExport } from '../../src/server/types.js';
import {
  FAKE_SECRET,
  control,
  createHarness,
  createSession,
  delay,
  errorBody,
  expectOk,
  ledgerSum,
  snapshot,
  waitFor,
  waitForStatus,
  type Harness,
} from './harness.js';

// Plenty of scripted outcomes for every test in this file (fixture cycles are not assumed).
const OUTCOMES = Array.from({ length: 200 }, (_, i) => (i * 7 + 3) % 37);

async function rounds(h: Harness, id: string): Promise<RoundRecord[]> {
  return expectOk(await h.api<{ rounds: RoundRecord[] }>('GET', `/api/sessions/${id}/rounds?limit=200`), 'rounds').rounds;
}
async function decisions(h: Harness, id: string): Promise<DecisionRecord[]> {
  return expectOk(await h.api<{ decisions: DecisionRecord[] }>('GET', `/api/sessions/${id}/decisions?limit=200`), 'decisions')
    .decisions;
}

/** Shared end-state invariants for any demo session. */
async function assertConsistent(h: Harness, id: string) {
  const snap = await snapshot(h, id);
  const rs = await rounds(h, id);
  expect(rs.every((r) => r.status === 'settled'), 'all rounds settled').toBe(true);
  expect(rs.every((r) => r.source === 'demo')).toBe(true);
  const seqs = rs.map((r) => r.seq).sort((a, b) => a - b);
  expect(seqs).toEqual(Array.from({ length: rs.length }, (_, i) => i + 1));
  expect(snap.session.roundsPlayed).toBe(rs.length);
  expect(snap.session.balance).toBe(snap.session.startingBalance + rs.reduce((s, r) => s + (r.net ?? 0), 0));
  const exp = JSON.parse((await h.api('GET', `/api/sessions/${id}/export?format=json`)).text) as SessionExport;
  expect(ledgerSum(exp.ledger)).toBe(snap.session.balance);
  // one decision drove each round; no round number received two accepted decisions (would mean two runners)
  const ds = await decisions(h, id);
  const accepted = ds.filter((d) => d.status === 'accepted' && d.action === 'bet');
  expect(new Set(accepted.map((d) => `${d.epoch}:${d.roundNumber}`)).size).toBe(accepted.length);
  for (const r of rs) if (r.decisionId) expect(ds.some((d) => d.id === r.decisionId)).toBe(true);
  return { snap, rs, ds };
}

describe('E2E demo session (rule-based demo player, FIXTURE outcomes)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ label: 'demo', outcomes: OUTCOMES, listen: true });
  });
  afterAll(async () => {
    for (const r of h?.transcript ?? []) expect(r.body.includes(FAKE_SECRET), `${r.method} ${r.url}`).toBe(false);
    await h?.close({ removeDb: true });
  });

  it('start → 5 settled rounds → completed(max_rounds); decisions labelled demo; SSE delivers the rounds', async () => {
    const created = await createSession(h, { name: 'e2e demo', player: { kind: 'demo' }, limits: { maxRounds: 5 } });
    const id = created.session.id;
    expect(created.session.mode).toBe('demo');
    expect(created.session.status).toBe('ready'); // no background run without an explicit Start

    // Open the event stream like the browser's EventSource (same-origin, no custom headers possible).
    const port = h.config.port;
    const abort = new AbortController();
    const events: ServerEvent[] = [];
    const sse = await fetch(`http://127.0.0.1:${port}/api/events?sessionId=${encodeURIComponent(id)}`, {
      headers: { accept: 'text/event-stream', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
      signal: abort.signal,
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type') ?? '').toMatch(/text\/event-stream/);
    expect(sse.headers.get('access-control-allow-origin')).toBeNull();
    const reader = sse.body!.getReader();
    const pump = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let cut: number;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const data = chunk
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (data) events.push(JSON.parse(data) as ServerEvent);
          }
        }
      } catch {
        /* aborted */
      }
    })();

    const started = expectOk(await control(h, id, 'start'), 'start');
    expect(['running', 'completed']).toContain(started.session.status);

    const done = await waitForStatus(h, id, ['completed', 'stopped', 'paused'], 15_000);
    expect(done.session.status).toBe('completed');
    expect(done.session.endReason).toBe('max_rounds');
    expect(done.inFlight).toEqual({ decision: false, round: false });

    const { rs, ds } = await assertConsistent(h, id);
    expect(rs).toHaveLength(5);
    expect(ds.length).toBeGreaterThanOrEqual(5);
    expect(ds.every((d) => d.providerKind === 'demo')).toBe(true);
    expect(ds.filter((d) => d.status === 'accepted').length).toBeGreaterThanOrEqual(5);
    // demo usage is never priced as a provider call
    const usage = expectOk(await h.api<{ records: { costBasis: string }[] }>('GET', `/api/sessions/${id}/usage`), 'usage');
    for (const u of usage.records) expect(['not-applicable']).toContain(u.costBasis);

    // SSE: at least one snapshot and a settled round event for each of the 5 rounds
    await waitFor(
      () => new Set(events.filter((e) => e.type === 'round' && e.round.status === 'settled').map((e) => e.type === 'round' && e.round.seq)).size >= 5,
      '5 settled round events over SSE',
      5_000,
    );
    expect(events.some((e) => e.type === 'snapshot')).toBe(true);
    for (const e of events) if (e.type === 'round') expect(e.round.sessionId).toBe(id);
    abort.abort();
    await pump;
    expect(h.outcomes.calls).toBeGreaterThanOrEqual(5);
  });

  it('repeated Start requests (double clicks, distinct keys) never create an extra runner', async () => {
    // A visible presentation delay keeps the runner busy long enough for the extra clicks to overlap it.
    const slow = await createHarness({ label: 'demo-starts', outcomes: OUTCOMES, presentationDelayMs: 40, sleep: 'real' });
    try {
      const { session } = await createSession(slow, { player: { kind: 'demo' }, limits: { maxRounds: 5 } });
      const burst = await Promise.all([control(slow, session.id, 'start'), control(slow, session.id, 'start'), control(slow, session.id, 'start')]);
      await delay(60);
      const late = await control(slow, session.id, 'start');
      for (const r of [...burst, late]) {
        // Accepted as a no-op (2xx snapshot) or refused as invalid_state — never a second loop.
        if (r.status >= 300) expect(['invalid_state', 'duplicate_request']).toContain(errorBody(r).code);
      }
      expect(burst.some((r) => r.status >= 200 && r.status < 300)).toBe(true);
      const done = await waitForStatus(slow, session.id, ['completed', 'stopped', 'paused'], 15_000);
      expect(done.session.status).toBe('completed');
      expect(done.session.endReason).toBe('max_rounds');
      const { rs } = await assertConsistent(slow, session.id);
      expect(rs).toHaveLength(5);
      // Start after completion must not run anything more.
      const again = await control(slow, session.id, 'start');
      expect(again.status).toBeGreaterThanOrEqual(400);
      await delay(150);
      expect(await rounds(slow, session.id)).toHaveLength(5);
      // Replaying a control Idempotency-Key has no further effect.
      const key = crypto.randomUUID();
      const r1 = await control(slow, session.id, 'start', key);
      const r2 = await control(slow, session.id, 'start', key);
      expect(r2.status).toBe(r1.status);
    } finally {
      await slow.close({ removeDb: true });
    }
  });

  it('pause after round → no background rounds; step plays exactly one round; stop is terminal', async () => {
    const hp = await createHarness({ label: 'demo-control', outcomes: OUTCOMES, presentationDelayMs: 30, sleep: 'real' });
    try {
      const { session } = await createSession(hp, { player: { kind: 'demo' }, limits: { maxRounds: 40 } });
      const id = session.id;
      expectOk(await control(hp, id, 'start'), 'start');
      await waitFor(async () => (await snapshot(hp, id)).session.roundsPlayed >= 1, 'first round', 10_000);

      const pauseRes = expectOk(await control(hp, id, 'pause'), 'pause');
      expect(['pause_requested', 'paused']).toContain(pauseRes.session.status);
      const paused = await waitForStatus(hp, id, ['paused'], 10_000);
      expect(paused.session.pauseReason).toBe('user_pause');
      expect(paused.currentRound?.status ?? 'settled').toBe('settled'); // pause happens after the round settles
      const n = paused.session.roundsPlayed;
      await delay(200);
      expect((await snapshot(hp, id)).session.roundsPlayed).toBe(n); // nothing runs while paused

      const stepRes = expectOk(await control(hp, id, 'step'), 'step');
      expect(['running', 'paused']).toContain(stepRes.session.status);
      const stepped = await waitFor(
        async () => {
          const s = await snapshot(hp, id);
          return s.session.status === 'paused' && s.session.roundsPlayed > n ? s : undefined;
        },
        'step to finish',
        10_000,
      );
      expect(stepped.session.roundsPlayed).toBe(n + 1);
      expect(stepped.session.pauseReason).toBe('step_complete');
      await delay(150);
      expect((await snapshot(hp, id)).session.roundsPlayed).toBe(n + 1);

      // resume, then stop mid-run
      expectOk(await control(hp, id, 'start'), 'resume');
      await waitFor(async () => (await snapshot(hp, id)).session.roundsPlayed >= n + 2, 'resumed round', 10_000);
      const stopRes = expectOk(await control(hp, id, 'stop'), 'stop');
      expect(['stop_requested', 'stopped']).toContain(stopRes.session.status);
      const stopped = await waitForStatus(hp, id, ['stopped'], 10_000);
      expect(stopped.session.endReason).toBe('user_stop');
      expect(stopped.inFlight).toEqual({ decision: false, round: false });
      const { rs } = await assertConsistent(hp, id); // a round committed before Stop was settled, not abandoned
      const count = rs.length;
      await delay(150);
      expect(await rounds(hp, id)).toHaveLength(count);

      // stopped is terminal: start/step are refused and change nothing
      for (const action of ['start', 'step'] as const) {
        const r = await control(hp, id, action);
        expect(r.status, `${action} after stop`).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
        errorBody(r);
      }
      await delay(100);
      expect(await rounds(hp, id)).toHaveLength(count);
      const final: SessionSnapshot = await snapshot(hp, id);
      expect(final.session.status).toBe('stopped');
    } finally {
      await hp.close({ removeDb: true });
    }
  });

  it('control rejects an unknown action with a 4xx ApiErrorBody', async () => {
    const { session } = await createSession(h, { player: { kind: 'demo' }, limits: { maxRounds: 1 } });
    const r = await control(h, session.id, 'explode');
    expect(r.status).toBe(400);
    expect(errorBody(r).code).toBe('validation_error');
    expect((await snapshot(h, session.id)).session.status).toBe('ready');
  });
});
