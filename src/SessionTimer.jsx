// Audit-budget countdown — an always-visible top-bar timer for the auditor's
// session budget (defaults to 30:00). It is the live answer to "how much of my
// 90-minute budget is left on THIS trace", so it persists per-trace in
// localStorage and is robust across reloads / crashes by design:
//
//   It stores a wall-clock ANCHOR, not a ticking number. The source of truth is
//   { durationMs, accumulatedMs, runningSince, state } — remaining is DERIVED on
//   every render from Date.now(). The 1s setInterval only forces a re-render so
//   the digits move; it carries no state. A reload therefore loses nothing: the
//   anchor is read back and the remaining time is recomputed exactly.
//
// Semantics (the user-chosen "mode B" + clarifications):
//   - The countdown advances on real wall-clock time WHILE in the `running`
//     state. The user pauses / resumes explicitly.
//   - Browser close / reopen does NOT pause it ("not affecting things"): a timer
//     left running keeps elapsing across the gap (runningSince predates the
//     reload). Those events are only LOGGED, for context.
//   - Pauses, resumes, edits, resets, and browser open/close are all recorded in
//     a per-trace activity log surfaced in the hover dropdown.
//
// Scope is PER-TRACE (keyed by the data store's `selectedInput`, the same stable
// directory name the overlays use) — each trace carries its own budget. Switch
// the trace, switch the timer. (One app-wide stopwatch instead would be a single
// constant key here.)
import React from 'react';
import { WF, L, inkBorder } from './primitives.jsx';
import { useData } from './dataStore.jsx';
import { logActivity } from './activityLog.js';
import { startAlarm } from './alarmSound.js';

const KEY = (name) => `redlogs:timer:${name}`;
const DEFAULT_DURATION_MS = 30 * 60 * 1000; // 30:00
const LOG_CAP = 100;                        // keep the tail; bound storage size

function defaultTimer() {
  return {
    v: 1,
    durationMs: DEFAULT_DURATION_MS,
    accumulatedMs: 0,      // counted elapsed from completed running segments
    runningSince: null,    // ts the current running segment began (running only)
    state: 'paused',       // 'running' | 'paused'
    startedAt: null,       // ts of the first start of the current run, or null
    alarmAck: false,       // auditor dismissed the "time up" alarm for THIS cycle
    log: [],               // [{ type, at, ...detail }]
  };
}

// Read + coerce a stored timer. Every field is validated so a hand-edited or
// older-shape payload can't wedge the UI; on any failure we fall back to a fresh
// 30:00. A `running` state with no anchor is impossible to resume meaningfully,
// so it's coerced to paused.
function loadTimer(name) {
  if (!name) return defaultTimer();
  try {
    const raw = localStorage.getItem(KEY(name));
    if (!raw) return defaultTimer();
    const o = JSON.parse(raw) || {};
    const d = defaultTimer();
    const t = {
      v: 1,
      durationMs: Number.isFinite(o.durationMs) && o.durationMs > 0 ? o.durationMs : d.durationMs,
      accumulatedMs: Number.isFinite(o.accumulatedMs) && o.accumulatedMs >= 0 ? o.accumulatedMs : 0,
      runningSince: Number.isFinite(o.runningSince) ? o.runningSince : null,
      state: o.state === 'running' ? 'running' : 'paused',
      startedAt: Number.isFinite(o.startedAt) ? o.startedAt : null,
      alarmAck: o.alarmAck === true,
      log: Array.isArray(o.log)
        ? o.log.filter((e) => e && typeof e.type === 'string' && Number.isFinite(e.at)).slice(-LOG_CAP)
        : [],
    };
    if (t.state === 'running' && t.runningSince == null) t.state = 'paused';
    return t;
  } catch {
    return defaultTimer();
  }
}

function persistTimer(name, t) {
  if (!name) return;
  try { localStorage.setItem(KEY(name), JSON.stringify(t)); } catch { /* quota / disabled storage */ }
}

function appendLog(t, type, detail) {
  const log = [...(t.log || []), { type, at: Date.now(), ...(detail || {}) }].slice(-LOG_CAP);
  return { ...t, log };
}

// Has the auditor actually engaged this timer? Pristine (never-touched) timers
// stay out of the activity log — we don't journal browser open/close noise for a
// budget the auditor never started.
function isEngaged(t) {
  return !!t && (t.state === 'running' || t.startedAt != null || t.accumulatedMs > 0);
}

// elapsed = banked segments + the open segment (running only). remaining is
// duration minus that, and may go negative (overtime).
function elapsedMs(t, now) {
  return t.accumulatedMs + (t.state === 'running' && t.runningSince ? Math.max(0, now - t.runningSince) : 0);
}

// MM:SS, minutes uncapped (a 90:00 budget reads "90:00", not "1:30:00") — the
// spec is "minutes and seconds only". ceil so a fresh 30:00 shows 30:00, not
// 29:59 on the first paint.
function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function fmtTimeOfDay(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return '—'; }
}

function fmtDateTime(ts) {
  try { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return '—'; }
}

// One log line's human label. Functions for the entries that carry detail.
const LOG_LABEL = {
  start: () => 'Started',
  resume: () => 'Resumed',
  pause: () => 'Paused',
  reset: (e) => `Reset to ${fmtClock(e.toMs)}`,
  edit: (e) => `Set to ${fmtClock(e.toMs)}${Number.isFinite(e.fromMs) ? ` (was ${fmtClock(e.fromMs)})` : ''}`,
  dismiss: () => 'Alarm dismissed',
  open: () => 'Browser opened',
  close: () => 'Browser closed',
};
const LOG_GLYPH = { start: '▶', resume: '▶', pause: '⏸', reset: '↺', edit: '✎', dismiss: '✕', open: '▽', close: '△' };

export function SessionTimer() {
  const { selectedInput } = useData();
  const name = selectedInput || null;

  const [timer, setTimer] = React.useState(() => loadTimer(name));
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [confirmingReset, setConfirmingReset] = React.useState(false);
  const [editMin, setEditMin] = React.useState('30');
  const [editSec, setEditSec] = React.useState('00');

  // Refs so the once-installed pagehide handler reads the live values without
  // re-subscribing on every change.
  const timerRef = React.useRef(timer);
  timerRef.current = timer;
  const nameRef = React.useRef(name);
  nameRef.current = name;
  const openLogged = React.useRef(false); // browser-open is logged once per page load
  const closeTimer = React.useRef(null);

  // Load this trace's timer whenever the trace changes. On the genuine first
  // page load (openLogged still false), record a "browser opened" entry for an
  // engaged timer — trace switches mid-session are silent.
  React.useEffect(() => {
    let t = loadTimer(name);
    if (!openLogged.current && name && isEngaged(t)) {
      t = appendLog(t, 'open');
      persistTimer(name, t);
    }
    if (name) openLogged.current = true;
    setConfirmingReset(false);
    setTimer(t);
  }, [name]);

  // Record "browser closed" on real document teardown (close / reload / nav).
  // pagehide (not visibilitychange) so a mere tab-switch isn't logged as a close.
  // The write is synchronous localStorage, fine during teardown.
  React.useEffect(() => {
    const onHide = () => {
      const t = timerRef.current;
      const n = nameRef.current;
      if (!n || !isEngaged(t)) return;
      persistTimer(n, appendLog(t, 'close'));
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  // Cosmetic tick: re-render once a second WHILE running so the digits move. The
  // displayed value is derived from Date.now(), so a missed/throttled tick (e.g.
  // a backgrounded tab) self-corrects on the next render — never drifts.
  const [, force] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => {
    if (timer.state !== 'running') return undefined;
    const id = setInterval(force, 1000);
    return () => clearInterval(id);
  }, [timer.state]);

  // Escape cancels an in-progress edit or a pending reset confirmation.
  React.useEffect(() => {
    if (!editing && !confirmingReset) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { setEditing(false); setConfirmingReset(false); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, confirmingReset]);

  const now = Date.now();
  const remaining = timer.durationMs - elapsedMs(timer, now);
  const isDone = remaining <= 0;
  const overMs = isDone ? -remaining : 0;
  const running = timer.state === 'running';
  // The alarm: live from the moment the budget hits 0:00 until the auditor
  // dismisses it (clicks the pill). It's derived, not a separate flag, so it
  // survives reloads — an expiry that was never acknowledged still greets you.
  const alarming = isDone && !timer.alarmAck;

  // Sound: loop the standard timer beep while alarming; stop on dismiss/unmount.
  // The visual pulse is pure CSS (the `wf-alarm-pill` class), so it keeps
  // throbbing even if the browser gates the audio until the next user gesture.
  React.useEffect(() => {
    if (!alarming) return undefined;
    const stop = startAlarm();
    return stop;
  }, [alarming]);

  // ── mutators — each updates state, appends its log entry, and persists ──────
  const commit = (mutate, logType, detail) => {
    setTimer((prev) => {
      const ts = Date.now();
      let next = mutate(prev, ts);
      if (logType) next = appendLog(next, logType, detail);
      persistTimer(name, next);
      return next;
    });
  };

  const toggleRun = () => {
    if (running) {
      commit((p, ts) => {
        let next = {
          ...p,
          state: 'paused',
          accumulatedMs: p.accumulatedMs + Math.max(0, ts - (p.runningSince || ts)),
          runningSince: null,
        };
        next = appendLog(next, 'pause');
        // Pausing at/after 0:00 also dismisses the live alarm: calling the
        // session by pausing should silence the beep/pulse, not just freeze
        // the overtime counter and leave it throbbing.
        if (alarming) next = appendLog({ ...next, alarmAck: true }, 'dismiss');
        return next;
      });
      logActivity('timer', { action: 'pause' });
      if (alarming) logActivity('timer', { action: 'dismiss' });
    } else {
      const first = timer.startedAt == null;
      commit((p, ts) => ({ ...p, state: 'running', runningSince: ts, startedAt: p.startedAt ?? ts }),
        first ? 'start' : 'resume');
      logActivity('timer', { action: first ? 'start' : 'resume' });
    }
  };

  // Dismiss the "time up" alarm — silences the sound and stops the red pulse,
  // leaving a static "time up" pill. Acknowledges only the current expiry; a
  // later reset/edit re-arms it. This is the pill's click action while alarming.
  const dismissAlarm = () => {
    commit((p) => ({ ...p, alarmAck: true }), 'dismiss');
    logActivity('timer', { action: 'dismiss' });
  };

  // Reset restarts the CURRENT duration, paused and unstarted.
  const reset = () => {
    commit((p) => ({ ...p, state: 'paused', accumulatedMs: 0, runningSince: null, startedAt: null, alarmAck: false }),
      'reset', { toMs: timer.durationMs });
    logActivity('timer', { action: 'reset' });
    setConfirmingReset(false);
  };

  // Editing the duration defines a NEW budget and leaves it ready (paused at the
  // new value) rather than recomputing a possibly-negative remaining.
  const beginEdit = () => {
    const total = Math.max(0, Math.round(timer.durationMs / 1000));
    setEditMin(String(Math.floor(total / 60)));
    setEditSec(String(total % 60).padStart(2, '0'));
    setConfirmingReset(false);
    setEditing(true);
    setOpen(true);
  };
  const saveEdit = () => {
    const mm = Math.max(0, Math.min(999, parseInt(editMin, 10) || 0));
    const ss = Math.max(0, Math.min(59, parseInt(editSec, 10) || 0));
    const newMs = (mm * 60 + ss) * 1000;
    if (newMs > 0) {
      commit((p) => ({ ...p, durationMs: newMs, state: 'paused', accumulatedMs: 0, runningSince: null, startedAt: null, alarmAck: false }),
        'edit', { fromMs: timer.durationMs, toMs: newMs });
      logActivity('timer', { action: 'edit', toMs: newMs });
    }
    setEditing(false);
  };

  // ── hover open/close (with a small grace delay so moving pill→panel is fine) ─
  const handleEnter = () => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpen(true); };
  const handleLeave = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => { if (!editing && !confirmingReset) setOpen(false); }, 140);
  };

  // While alarming the pill is a solid red field, so its text/dot flip to the
  // light on-accent ink for contrast against the throbbing background.
  const timeColor = alarming ? WF.onAccent : isDone ? WF.heat4 : running ? WF.ink : WF.ink2;
  // Traffic-light dot: red when over budget, green while running, amber/yellow
  // while paused or not-yet-started ("inactive").
  const dotColor = alarming ? WF.onAccent : isDone ? WF.heat4 : running ? WF.add : WF.tagAmberFg;
  const showPanel = open || editing;

  return (
    <div
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{ position: 'relative', display: 'inline-flex' }}
    >
      {/* Pill — always visible. Click the time to customize the duration. */}
      <button
        type="button"
        className={alarming ? 'wf-alarm-pill' : undefined}
        aria-label={alarming ? 'time up — click to dismiss the alarm' : 'audit session timer'}
        title={alarming
          ? 'time up — click to dismiss the alarm'
          : 'audit session timer — click to set the duration; hover for controls and history'}
        onClick={alarming ? dismissAlarm : beginEdit}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          padding: '3px 9px',
          border: alarming ? `1.5px solid ${WF.heat4}` : inkBorder(showPanel ? 1.5 : 1.2),
          background: alarming ? WF.heat4 : WF.paper,
          cursor: 'pointer',
        }}
      >
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
        <L mono size={13} color={timeColor} style={{ letterSpacing: 0.5, fontWeight: 500 }}>
          {fmtClock(Math.max(0, remaining))}
        </L>
        {!running && timer.startedAt != null && !isDone && (
          <L mono size={9} color={WF.ink3} style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>paused</L>
        )}
        {isDone && (
          <L mono size={9} color={alarming ? WF.onAccent : WF.heat4} style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>time up</L>
        )}
      </button>

      {showPanel && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 30,
            right: 0,
            zIndex: 1100,
            width: 260,
            padding: '10px 12px',
            background: WF.paper,
            border: inkBorder(1.5),
            boxShadow: `3px 3px 0 ${WF.shadow}`,
          }}
        >
          <L mono size={10} color={WF.ink3} style={{ display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            session timer
          </L>

          {/* Big readout + state */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
            <L mono size={26} color={isDone ? WF.heat4 : WF.ink} style={{ fontWeight: 600, letterSpacing: 1 }}>
              {fmtClock(Math.max(0, remaining))}
            </L>
            <L mono size={10} color={isDone ? WF.heat4 : WF.ink3} style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {isDone ? `over by ${fmtClock(overMs)}` : running ? 'running' : timer.startedAt != null ? 'paused' : 'ready'}
            </L>
          </div>

          {/* Started-on + projected-end context */}
          <L mono size={10} color={WF.ink3} style={{ display: 'block' }}>
            {timer.startedAt != null ? `started ${fmtDateTime(timer.startedAt)}` : 'not started yet'}
          </L>
          {/* Always present (no layout jump on pause/resume). While running it's
              the live projection; paused/ready it's the projection if resumed now;
              done it just states it reached 0:00. */}
          <L mono size={10} color={WF.ink3} style={{ display: 'block', marginTop: 1 }}>
            {isDone
              ? 'reached 0:00'
              : running
                ? `reaches 0:00 ~ ${fmtTimeOfDay(now + remaining)}`
                : `reaches 0:00 ~ ${fmtTimeOfDay(now + remaining)} if resumed`}
          </L>

          {/* Controls / editor */}
          <div style={{ marginTop: 10 }}>
            {editing ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <TimePart value={editMin} onChange={setEditMin} onEnter={saveEdit} ariaLabel="minutes" max={3} />
                <L mono size={14} color={WF.ink2}>:</L>
                <TimePart value={editSec} onChange={setEditSec} onEnter={saveEdit} ariaLabel="seconds" max={2} />
                <div style={{ flex: 1 }} />
                <PanelButton onClick={saveEdit} filled>save</PanelButton>
                <PanelButton onClick={() => setEditing(false)}>cancel</PanelButton>
              </div>
            ) : confirmingReset ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <L mono size={11} color={WF.ink2} style={{ flex: 1, minWidth: 0 }}>
                  reset to {fmtClock(timer.durationMs)}?
                </L>
                <PanelButton onClick={reset} filled>confirm</PanelButton>
                <PanelButton onClick={() => setConfirmingReset(false)}>cancel</PanelButton>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <PanelButton onClick={toggleRun} filled={!running} wide>
                  {running ? '⏸ pause' : timer.startedAt != null ? '▶ resume' : '▶ start'}
                </PanelButton>
                <PanelButton onClick={() => setConfirmingReset(true)}>reset</PanelButton>
                <PanelButton onClick={beginEdit}>edit</PanelButton>
              </div>
            )}
          </div>

          {/* Activity log */}
          <div style={{ borderTop: inkBorder(1.2), margin: '10px -12px 0', paddingTop: 8 }} />
          <L mono size={10} color={WF.ink3} style={{ display: 'block', padding: '0 12px 6px', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            activity
          </L>
          {timer.log.length === 0 ? (
            <L mono size={11} color={WF.ink3} style={{ display: 'block', padding: '0 12px' }}>no activity yet</L>
          ) : (
            <div style={{ maxHeight: 168, overflowY: 'auto', padding: '0 12px', margin: '0 -12px' }}>
              {[...timer.log].reverse().map((e, i) => (
                <div key={timer.log.length - i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 12px' }}>
                  <L mono size={10} color={WF.ink3} style={{ width: 12, flexShrink: 0, textAlign: 'center' }}>
                    {LOG_GLYPH[e.type] || '·'}
                  </L>
                  <L mono size={11} color={WF.ink2} style={{ flex: 1, minWidth: 0 }}>
                    {(LOG_LABEL[e.type] || (() => e.type))(e)}
                  </L>
                  <L mono size={10} color={WF.ink3} style={{ flexShrink: 0 }}>{fmtTimeOfDay(e.at)}</L>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A small mono text button matching the popover idiom in settings.jsx.
function PanelButton({ children, onClick, filled = false, wide = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '4px 10px',
        minWidth: wide ? 84 : undefined,
        fontFamily: WF.monoFont,
        fontSize: 12,
        border: inkBorder(filled ? 1.5 : 1.2),
        background: filled ? WF.ink : WF.paper,
        color: filled ? WF.paper : WF.ink2,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// One numeric field of the MM:SS editor. Digits only; Enter commits.
function TimePart({ value, onChange, onEnter, ariaLabel, max }) {
  return (
    <input
      aria-label={ariaLabel}
      inputMode="numeric"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, max))}
      onKeyDown={(e) => { if (e.key === 'Enter') onEnter(); }}
      onFocus={(e) => e.target.select()}
      style={{
        width: 44,
        padding: '4px 6px',
        fontFamily: WF.monoFont,
        fontSize: 14,
        textAlign: 'center',
        border: inkBorder(1.2),
        background: WF.paper,
        color: WF.ink,
      }}
    />
  );
}
