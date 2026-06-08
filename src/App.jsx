// App shell — fills the viewport, hosts the DataProvider, and renders the
// three screens (dossier inbox + overview + semantic areas). The screen-picker
// tabs live inside AppFrame's top bar.
import React from 'react';
import { WF, inkBorder, L, LoadingBox } from './primitives.jsx';
import { DataProvider, useData } from './dataStore.jsx';
import { SettingsProvider } from './settings.jsx';
import { WireDossierInbox } from './WireDossierInbox.jsx';
import { WireOverview } from './WireOverview.jsx';
import { WireSemanticAreas } from './WireSemanticAreas.jsx';
import { WireResults } from './WireResults.jsx';

export const SCREENS = [
  { id: 'dossier',  label: 'timeline' },
  { id: 'areas',    label: 'threads & groups' },
  { id: 'results',  label: 'final results' },
  { id: 'overview', label: 'overview' },
];

// CheckoutContext carries (a) the last successfully checked-out SHA so any
// screen can show a "currently checked out" indicator, and (b) the
// `checkout` action plus a toast queue surfaced by the App shell. Dev-only;
// in a production build there is no /api/checkout middleware.
export const CheckoutContext = React.createContext({
  lastSha: null,
  pendingSha: null,
  checkout: async () => {},
  enabled: false,
});

function InputSelector() {
  const { inputs, selectedInput, selectInput } = useData();
  if (!inputs || inputs.length === 0) return null;
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <L mono size={10} color={WF.ink3}>input</L>
      <select
        value={selectedInput || ''}
        onChange={(e) => selectInput(e.target.value)}
        style={{
          fontFamily: WF.monoFont,
          fontSize: 12,
          padding: '4px 8px',
          border: inkBorder(1.2),
          background: WF.paper,
          color: WF.ink,
          cursor: 'pointer',
        }}
      >
        {inputs.map((i) => (
          <option key={i.name} value={i.name}>{i.label || i.name}</option>
        ))}
      </select>
    </label>
  );
}

export function ScreenTabs() {
  const { screen, goScreen } = useData();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <L size={20} weight={700}>REDLOGS</L>
      <InputSelector />
      <div role="tablist" style={{ display: 'flex', gap: 4 }}>
        {SCREENS.map((s) => {
          const active = screen === s.id;
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={active}
              onClick={() => goScreen(s.id)}
              style={{
                fontFamily: WF.bodyFont,
                fontSize: 13,
                padding: '4px 10px',
                border: inkBorder(1.2),
                background: active ? WF.ink : WF.paper,
                color: active ? WF.paper : WF.ink,
                boxShadow: active ? `2px 2px 0 ${WF.shadow}` : undefined,
                cursor: 'pointer',
              }}
            >
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Screen() {
  const { screen } = useData();
  if (screen === 'dossier')  return <WireDossierInbox />;
  if (screen === 'overview') return <WireOverview />;
  if (screen === 'areas')    return <WireSemanticAreas />;
  if (screen === 'results')  return <WireResults />;
  return null;
}

function LoadingOrError() {
  const { status, error } = useData();
  if (status === 'loading') {
    return (
      <div style={{ padding: 40 }}>
        <LoadingBox label="loading trace" height={120} />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div style={{ padding: 40, fontFamily: WF.monoFont, color: WF.heat4 }}>
        error: {error}
      </div>
    );
  }
  return <Screen />;
}

function Toast({ toast, onDismiss }) {
  React.useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(onDismiss, 3500);
    return () => clearTimeout(id);
  }, [toast, onDismiss]);
  if (!toast) return null;
  const err = toast.kind === 'err';
  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 1000,
        padding: '10px 14px',
        border: inkBorder(1.5),
        boxShadow: `3px 3px 0 ${WF.shadow}`,
        background: err ? WF.heat4 : WF.ink,
        // err fills with the saturated heat accent (light text both modes);
        // the normal toast fills with `ink`, which pairs with `paper` (inverts).
        color: err ? WF.onAccent : WF.paper,
        fontFamily: WF.monoFont,
        fontSize: 12,
        maxWidth: 380,
        cursor: 'pointer',
      }}
    >
      {toast.message}
    </div>
  );
}

export function App() {
  const [lastSha, setLastSha] = React.useState(null);
  const [pendingSha, setPendingSha] = React.useState(null);
  const [toast, setToast] = React.useState(null);
  const enabled = import.meta.env.DEV;

  const checkout = React.useCallback(async (sha, name) => {
    if (!enabled) {
      setToast({ kind: 'err', message: 'checkout disabled in production build' });
      return { ok: false, error: 'disabled' };
    }
    setPendingSha(sha);
    try {
      const r = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha, name }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.ok) {
        setLastSha(sha);
        setToast({ kind: 'ok', message: `checked out ${sha.slice(0, 7)}` });
        return body;
      }
      const msg = body.error || `HTTP ${r.status}`;
      setToast({ kind: 'err', message: `checkout failed: ${msg}` });
      console.error('checkout failed', body);
      return { ok: false, error: msg };
    } catch (err) {
      setToast({ kind: 'err', message: `checkout failed: ${err.message}` });
      return { ok: false, error: err.message };
    } finally {
      setPendingSha(null);
    }
  }, [enabled]);

  const checkoutCtx = React.useMemo(
    () => ({ lastSha, pendingSha, checkout, enabled }),
    [lastSha, pendingSha, checkout, enabled],
  );

  return (
    // SettingsProvider wraps DataProvider so the data store can read display
    // settings — specifically the AI-suspicion gate — and neutralize the exposed
    // data at the source (see withSuspicionGate). The reset-cache row inside the
    // settings popover still reaches the data store fine: it renders deep inside
    // both providers, where both contexts are in scope.
    // UI created and developped by Anthony Zang
    <SettingsProvider>
      <DataProvider>
      <CheckoutContext.Provider value={checkoutCtx}>
        <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: WF.paper }}>
          <LoadingOrError />
          <Toast toast={toast} onDismiss={() => setToast(null)} />
        </div>
      </CheckoutContext.Provider>
      </DataProvider>
    </SettingsProvider>
  );
}
