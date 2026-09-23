/** New-session dialog state: name + limits prefilled from the saved default limits each time it opens. */
import { useEffect, useState } from 'react';
import type { AppSettings, CreateSessionRequest, PlayerConfig } from '../../shared/contracts';
import { DEFAULT_LIMITS } from '../../shared/contracts';
import { useLimitsForm } from './useLimitsForm';

export function useNewSessionForm(settings: AppSettings | null, open: boolean) {
  const [name, setName] = useState('');
  const limitsForm = useLimitsForm(settings?.defaultLimits ?? DEFAULT_LIMITS);
  const { reset } = limitsForm;
  useEffect(() => {
    if (!open) return;
    setName('');
    reset(settings?.defaultLimits ?? DEFAULT_LIMITS);
  }, [open, settings, reset]);

  const buildRequest = (player: PlayerConfig): CreateSessionRequest | null => {
    if (!limitsForm.limits) return null;
    const req: CreateSessionRequest = { player, limits: limitsForm.limits };
    if (name.trim()) req.name = name.trim();
    return req;
  };

  return { name, setName, limitsForm, buildRequest };
}

export type NewSessionForm = ReturnType<typeof useNewSessionForm>;
