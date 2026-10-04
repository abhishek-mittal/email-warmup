'use client';

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { FEATURES, FEATURE_BY_ID } from './registry';

const STORAGE_KEY = 'ew.features.v1';

type Overrides = Record<string, boolean>;

const listeners = new Set<() => void>();
let cached: { raw: string | null; value: Overrides } = { raw: null, value: {} };

function read(): Overrides {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== cached.raw) cached = { raw, value: raw ? (JSON.parse(raw) as Overrides) : {} };
  } catch {
    // Storage blocked: everything stays at its default.
  }
  return cached.value;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function write(next: Overrides) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not persisted; still applies until reload.
    cached = { raw: JSON.stringify(next), value: next };
  }
  listeners.forEach((l) => l());
}

const SERVER: Overrides = {};

interface FeatureApi {
  isEnabled: (id: string) => boolean;
  setEnabled: (id: string, enabled: boolean) => void;
  setMany: (ids: string[], enabled: boolean) => void;
  reset: () => void;
  hiddenCount: number;
}

const FeatureContext = createContext<FeatureApi | null>(null);

/** Keep/hide decisions, stored in this browser. Everything is on by default. */
export function FeatureProvider({ children }: { children: React.ReactNode }) {
  const overrides = useSyncExternalStore(subscribe, read, () => SERVER);

  const isEnabled = useCallback(
    (id: string) => {
      const feature = FEATURE_BY_ID[id];
      if (!feature) return false;
      return overrides[id] ?? true;
    },
    [overrides],
  );

  const api = useMemo<FeatureApi>(
    () => ({
      isEnabled,
      setEnabled: (id, enabled) => write({ ...read(), [id]: enabled }),
      setMany: (ids, enabled) => write({ ...read(), ...Object.fromEntries(ids.map((id) => [id, enabled])) }),
      reset: () => write({}),
      hiddenCount: FEATURES.filter((f) => overrides[f.id] === false).length,
    }),
    [isEnabled, overrides],
  );

  return <FeatureContext.Provider value={api}>{children}</FeatureContext.Provider>;
}

export function useFeatures(): FeatureApi {
  const ctx = useContext(FeatureContext);
  if (!ctx) throw new Error('useFeatures must be used inside FeatureProvider');
  return ctx;
}
