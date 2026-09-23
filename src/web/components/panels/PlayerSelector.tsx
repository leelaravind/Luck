import { Bot, Hand, Sparkles } from 'lucide-react';
import { useId } from 'react';
import type { AiProviderKind, ConnectionTestResult, PlayerKind, ProviderStatus } from '../../../shared/contracts';
import { COPY } from '../../copy';
import { providerAvailability } from '../../state/availability';
import { Badge } from '../common/Badge';
import { RadioCard } from '../common/RadioCard';

/**
 * Player choice for the next session: Manual, the rule-based Demo player (explicitly "not AI"), and every
 * AI provider reported by GET /api/providers with its real availability. Providers are never invented.
 */
export interface PlayerSelectorProps {
  readonly providers: readonly ProviderStatus[];
  readonly providerTests: Partial<Record<AiProviderKind, ConnectionTestResult>>;
  readonly value: PlayerKind;
  readonly onChange: (kind: PlayerKind) => void;
  readonly legend?: string;
}

export function PlayerSelector({ providers, providerTests, value, onChange, legend = 'Player' }: Readonly<PlayerSelectorProps>) {
  const name = useId();
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
      <legend className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{legend}</legend>
      <RadioCard<PlayerKind>
        name={name}
        value="manual"
        checked={value === 'manual'}
        onChange={onChange}
        icon={<Hand className="h-4 w-4" />}
        label="Manual (you)"
      />
      <RadioCard<PlayerKind>
        name={name}
        value="demo"
        checked={value === 'demo'}
        onChange={onChange}
        icon={<Sparkles className="h-4 w-4" />}
        label="Demo player"
        detail={<Badge tone="neutral">{COPY.demoTagline}</Badge>}
      />
      {providers.map((p) => {
        const a = providerAvailability(p, providerTests[p.kind]);
        return (
          <RadioCard<PlayerKind>
            key={p.kind}
            name={name}
            value={p.kind}
            checked={value === p.kind}
            onChange={onChange}
            icon={<Bot className="h-4 w-4" />}
            label={p.capabilities.label}
            detail={
              <Badge tone={a.tone} title={a.title}>
                {a.label}
              </Badge>
            }
          />
        );
      })}
      {providers.length === 0 ? (
        <p className="m-0 text-[11px] text-ink-muted">No AI providers reported by the server.</p>
      ) : null}
    </fieldset>
  );
}

export default PlayerSelector;
