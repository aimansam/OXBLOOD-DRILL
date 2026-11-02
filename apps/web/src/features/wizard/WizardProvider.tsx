import { type ReactNode, createContext, useCallback, useContext, useState } from 'react';
import { CreateWizard } from './CreateWizard';

interface OpenOptions {
  scenarioId?: number | null;
}
const WizardContext = createContext<{ open: (options?: OpenOptions) => void } | null>(null);

export function useWizard() {
  const ctx = useContext(WizardContext);
  if (!ctx) throw new Error('useWizard must be used inside WizardProvider');
  return ctx;
}

export function WizardProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; scenarioId: number | null; key: number }>({ open: false, scenarioId: null, key: 0 });
  const open = useCallback(
    (options?: OpenOptions) => setState((s) => ({ open: true, scenarioId: options?.scenarioId ?? null, key: s.key + 1 })),
    [],
  );
  return (
    <WizardContext.Provider value={{ open }}>
      {children}
      {/* `key` remounts the wizard so every opening starts from a clean state */}
      <CreateWizard key={state.key} open={state.open} initialScenarioId={state.scenarioId} onOpenChange={(o) => setState((s) => ({ ...s, open: o }))} />
    </WizardContext.Provider>
  );
}
