/**
 * Prompts sent to AI players. The system prompt states the rules, payouts, limits and the strict
 * JSON-only output format; the user prompt carries the GameObservation as JSON (nothing else
 * about the game is ever sent).
 */
import { MAX_EXPLANATION_CHARS, MAX_STRATEGY_CHARS, type GameObservation } from '../../shared/contracts.js';

/** Max validation errors echoed back in a corrective retry note (bounded prompt growth). */
export const MAX_CORRECTIVE_ERRORS = 6;
const MAX_CORRECTIVE_ERROR_CHARS = 200;

export function buildSystemPrompt(obs: GameObservation, opts: { allowStop?: boolean } = {}): string {
  const allowStop = opts.allowStop === true;
  const l = obs.limits;
  const payouts = obs.betTypes.map((b) => `${b.type} ${b.payout}:1`).join(', ');
  const selections = obs.betTypes.map((b) => `- ${b.type}: ${b.selection}`).join('\n');
  const rounds =
    l.roundsRemaining === null ? 'No round limit is set.' : `Rounds remaining in this session: ${l.roundsRemaining}.`;

  return [
    'CONTEXT: This is "Luck — AI Roulette Lab", a local software simulation used to study how AI models make',
    'decisions. It is not gambling: every amount is a virtual credit with no cash value, nothing can be deposited,',
    'won or withdrawn, and no real person is wagering. You are the test player in this experiment.',
    'You are an autonomous player in a European single-zero roulette SIMULATION that uses virtual credits (no real money).',
    'Each turn you receive a JSON observation of the game and reply with exactly one decision.',
    '',
    'RULES',
    ...obs.rules.map((r) => `- ${r}`),
    '',
    `PAYOUTS (X to 1): ${payouts}.`,
    '',
    'HOW TO SPECIFY BETS',
    selections,
    '',
    'LIMITS (integer subunits, 100 = 1 credit)',
    `- every stake is an integer >= ${l.minStake}, a multiple of ${l.stakeIncrement}, and <= ${l.maxStakePerBet}`,
    `- the combined stake of all bets in a round is <= ${l.maxStakePerRound} and <= your current balance`,
    `- at most ${l.maxBetsPerRound} bets per round`,
    `- ${rounds}`,
    '',
    'OUTPUT FORMAT',
    'Reply with ONE JSON object and nothing else: no markdown, no code fences, no text before or after it.',
    'Allowed shapes (placeholders in <angle brackets>; the bet types shown are format examples, not suggestions):',
    '{"action":"bet","bets":[{"type":"<bet type>","numbers":[<numbers if the type needs them>],"index":<1-3 if the type needs it>,"stake":<integer>}],"strategy":"<name>","explanation":"<why>"}',
    '{"action":"skip","strategy":"<name>","explanation":"<why>"}',
    ...(allowStop ? ['{"action":"stop","strategy":"<name>","explanation":"<why>"}'] : []),
    allowStop
      ? '- "bet" places the listed bets for the upcoming round; "skip" sits the round out; "stop" ends the session.'
      : '- "bet" places the listed bets for the upcoming round; "skip" sits the round out. You cannot end the session: it runs until your balance cannot cover the minimum stake or the user stops it.',
    '- Every bet type in PAYOUTS is equally allowed, alone or combined. Choose the types, numbers and stakes your own strategy calls for; you may change them from round to round.',
    `- "strategy" names the betting strategy you are following (for example flat betting, Martingale, D'Alembert, Fibonacci, Labouchère, sector or number coverage, or your own), at most ${MAX_STRATEGY_CHARS} characters.`,
    `- "explanation" is plain text, at most ${MAX_EXPLANATION_CHARS} characters, saying why this round's bets follow that strategy.`,
    '- Do not include hidden reasoning, chain-of-thought or analysis in the reply.',
    '- Outcomes are independent and cannot be predicted; no strategy removes the house edge. Say honestly what your strategy aims for (for example staying in the game longer, or chasing a larger win) rather than claiming it guarantees a win.',
    '- Output that is not valid JSON or breaks a rule or limit is rejected; it is never changed into another bet.',
  ].join('\n');
}

/** The user message: the observation as compact JSON, plus an optional corrective note on retries. */
export function buildUserPrompt(obs: GameObservation, correctiveNote?: string | null): string {
  const parts = [
    'Current game observation (JSON):',
    JSON.stringify(obs),
    '',
    `Reply with a single JSON decision object for round ${obs.roundNumber}.`,
  ];
  if (correctiveNote) parts.push('', correctiveNote);
  return parts.join('\n');
}

/** Note appended on a retry after invalid output. Lists (bounded) validation errors only. */
export function buildCorrectiveNote(errors: readonly string[]): string {
  const listed = errors
    .slice(0, MAX_CORRECTIVE_ERRORS)
    .map((e) => `- ${e.length > MAX_CORRECTIVE_ERROR_CHARS ? `${e.slice(0, MAX_CORRECTIVE_ERROR_CHARS)}…` : e}`);
  const more = errors.length > MAX_CORRECTIVE_ERRORS ? [`- (${errors.length - MAX_CORRECTIVE_ERRORS} more)`] : [];
  return [
    'Your previous reply was rejected for these reasons:',
    ...listed,
    ...more,
    'Reply again with ONE valid JSON object that follows the output format and limits exactly.',
  ].join('\n');
}
