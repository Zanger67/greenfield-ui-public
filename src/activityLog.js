// Append-only UI activity log — the chronological record of what the auditor
// *did* (pages opened, tabs switched, flags, notes, tags, settings, copies),
// distinct from the audit overlay mirror (user/ + status/), which is the current
// *state*. React-free and tiny: callers fire logActivity(type, detail) from the
// few action chokepoints; this buffers and flushes the batch to the dev-server's
// POST /api/audit-log, which APPENDS each event as one JSONL line to the trace's
// own <traceDir>/audit/activity/activity.jsonl. The state mirror overwrites; this
// only ever grows.
//
// Dev-only: a static build has no endpoint, so import.meta.env.DEV gates it (no
// 404 noise). Every path swallows its own errors — logging an action must never
// surface to, or break, the UI it is observing.
const ENABLED = import.meta.env.DEV;
const LOG_URL = '/api/audit-log';
const FLUSH_MS = 1500;       // coalesce a burst of clicks into one POST
const MAX_BUFFER = 200;      // backstop: flush early rather than grow unbounded

// The current trace + screen, set by the data store (see setLogContext). Stamped
// onto every event so an action fired far from the store — a settings toggle, a
// copy click — still records where the auditor was when they did it.
let ctx = { trace: null, screen: null };
let buffer = [];
let timer = null;

export function setLogContext(next) {
  if (next && typeof next === 'object') ctx = { ...ctx, ...next };
}

// Ship the buffer. Partition by trace (a trace swap can land events for two
// traces in one buffer) so each batch is appended to the right trace's log.
// `useBeacon` routes through sendBeacon for the pagehide / tab-hide case, where a
// normal fetch may be cancelled as the document tears down.
function flush(useBeacon) {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!buffer.length) return;
  const byTrace = new Map();
  for (const ev of buffer) {
    if (!ev || !ev.trace) continue;
    if (!byTrace.has(ev.trace)) byTrace.set(ev.trace, []);
    byTrace.get(ev.trace).push(ev);
  }
  buffer = [];
  for (const [name, events] of byTrace) {
    const payload = JSON.stringify({ name, events });
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(LOG_URL, new Blob([payload], { type: 'application/json' }));
      } else {
        fetch(LOG_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => { /* offline / no dev server — the log is best-effort */ });
      }
    } catch { /* sendBeacon / Blob unavailable — drop this batch, never throw */ }
  }
}

// Record one user action. `type` is a short tag ('nav', 'flag', 'note-add',
// 'settings', 'copy', …); `detail` is any small JSON describing it. The event is
// stamped with an ISO timestamp and the current trace/screen, buffered, and
// flushed on a trailing debounce (or immediately past MAX_BUFFER).
export function logActivity(type, detail) {
  if (!ENABLED || !type || !ctx.trace) return;
  try {
    buffer.push({ t: new Date().toISOString(), type, screen: ctx.screen, trace: ctx.trace, ...(detail || {}) });
    if (buffer.length >= MAX_BUFFER) { flush(false); return; }
    if (!timer) timer = setTimeout(() => flush(false), FLUSH_MS);
  } catch { /* never let a log call break its caller */ }
}

// Flush the tail of a session before the tab is hidden / unloaded, so the last
// few actions aren't lost in the pending debounce. Guarded for non-browser
// imports (the module sits next to React-free serializers).
if (ENABLED && typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flush(true));
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
}
