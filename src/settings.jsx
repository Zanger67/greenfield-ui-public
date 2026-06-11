// Auditor display settings — small, app-wide toggles that persist in
// localStorage (survive trace swaps, reloads, tab close) so a preference set
// once stays set. Decoupled from the trace data store on purpose: these are
// about how the UI renders, not about which trace is loaded.
//
// First setting: `showTimestamps`. Raw wall-clock times on every edit / log
// item are noise for most of an audit, so they default OFF. Relationship
// signals that read off the spine — "N commits between", file-continuation
// order, kind/source — are NOT timestamps and stay visible regardless; only
// the literal date/time strings are gated (see <Stamp>).
import React from 'react';
import { WF, L, inkBorder, scrambleText } from './primitives.jsx';
import { useData } from './dataStore.jsx';
import { logActivity } from './activityLog.js';

const SETTINGS_KEY = 'redlogs:settings';
// `inboxSubline` chooses what the greyed secondary line under each inbox row
// shows: 'operation' (the raw audit op, e.g. "modified (MOVE_TO)" — the
// default), 'shortTitle' (the annotation agent's <=10-word headline, if any),
// 'annotation' (a clipped form of the agent's full "what is being done" note),
// or 'none' (hide the line). `inboxTitleFromShortTitle` swaps the row's primary
// line from the touched file to that short title when one exists.
// `paneWidths` holds the auditor's resized pane sizes (px) keyed by pane:
// `inboxList` / `fileTimeline` are the dossier screen's left bar and right
// commit-timeline; `areasSidebar` / `auditorPanel` are the semantic-areas left
// rail and right auditor panel. The middle dossier/detail pane is flex-filled,
// so it has no stored width — it's whatever the side panes leave. `dossierNotes`
// is the odd one out: a *height* (not a width), the validator-notes box that
// shares the file-timeline column with the commit list and can be dragged taller
// into that list (capped at 60% of the shared space — see <FileTimeline>).
// Defaults match the previously-hardcoded sizes so a fresh session looks
// unchanged. See <PaneResizer> for the drag affordance.
export const PANE_DEFAULTS = {
  inboxList: 520,
  fileTimeline: 256,
  areasSidebar: 360,
  auditorPanel: 320,
  dossierNotes: 200,
  resultsNav: 280,
};

const DEFAULTS = {
  // Dark mode defaults ON. The palette swap is a CSS-variable flip on
  // <html data-theme> — index.html holds the light/dark var blocks and a
  // pre-paint script that applies this same default before React mounts (so a
  // fresh load goes straight to dark, no flash); the SettingsProvider effect
  // below re-asserts it and drives live toggling.
  darkMode: true,
  showTimestamps: false,
  // Per-commit short SHAs in dossier rows / tree. Defaults OFF — the hashes are
  // navigational noise for most of an audit (every row reads as an opaque 7-char
  // blob); flip it on from the gear popover when you actually need to cross-ref a
  // specific commit. Gates the <Sha> column in WireDossierInbox and the related-row
  // prefix; see <Sha> in this file.
  showCommitHashes: false,
  // Source-diff line numbers (old/new gutter on the left of each hunk). Defaults
  // ON — the gutter is the quickest way to map a flagged change back to a file
  // location, and it's the standard shape auditors expect from a code diff. Only
  // the source-file diff body honors it; the append-only log views render
  // filtered changed-lines with no hunk headers, so numbering there is moot.
  showLineNumbers: true,
  // The "audit event" box on a file-edit dossier — the raw audit-event payload
  // (file / event / action / baseline). It's a low-level detail most of an audit
  // doesn't need surfaced on every commit, so it defaults OFF; flip it on from
  // the gear popover. Only the audit-source box is gated — the shell-command,
  // claude-tool, and event-payload boxes are unaffected. See <RawLineDetail> and
  // its call site in <DossierBody>.
  showAuditEventBox: false,
  // The AI suspicion layer (narrator flag levels, the suspicion sections,
  // flagged semantic areas, the suspect filter facet, the heat gutter) defaults
  // OFF — anti-anchoring. A fresh auditor forms an independent read of the trace
  // before the model's guesses are surfaced, then flips it on to compare. The
  // toggle is the top-bar pill (<AiFlagsToggle>), not a buried popover row,
  // precisely because default-off means its presence must be self-evident. The
  // data store neutralizes the exposed data at the source when this is off —
  // see withSuspicionGate in dataStore.jsx.
  showAiSuspicion: false,
  inboxSubline: 'none',
  inboxTitleFromShortTitle: true,
  // The "adding a tag flags this <noun>" helper line under each tag editor.
  // Tag-as-flag is a learn-once mechanic — once an auditor knows that tagging
  // an item also flags it, the reminder is just clutter on every dossier — so
  // it defaults OFF. Flip it on from the gear popover. See <TagFlagsHint>.
  showTagFlagsHint: false,
  // "Anonymous mode" — a privacy screen for screenshots / screen-shares / external
  // demos. When ON, every piece of on-screen text DERIVED FROM THE TRACE (code,
  // diffs, commands, agent/narrator annotations, commit messages, file paths,
  // documents, the trace label) is run through scrambleText (see primitives.jsx):
  // same silhouette — word lengths, line breaks, indentation, +/- gutters,
  // markdown markers — with the letters/digits replaced. Defaults OFF. It is a
  // pure RENDER-TIME transform: the underlying data is untouched, so navigation,
  // git lookups, filters, and the AI_AUDIT.md export all keep operating on the
  // real values. UI chrome (labels, headers, settings) and the auditor's OWN
  // markup (notes, group names, validator notes, tags) are NOT scrambled —
  // anonymisation covers what came from the trace, not what you typed. The toggle
  // reaches every site via the `anon` function from useAnonymize(); see <Anon>.
  anonymize: false,
  paneWidths: PANE_DEFAULTS,
};

// Options for the inbox subline select, in display order.
export const INBOX_SUBLINE_OPTIONS = [
  { value: 'operation', label: 'operation', hint: 'raw audit op, e.g. modified (MOVE_TO)' },
  { value: 'shortTitle', label: 'short title', hint: 'annotation agent headline' },
  { value: 'annotation', label: 'description', hint: 'clipped "what is being done"' },
  { value: 'none', label: 'none', hint: 'hide the line' },
];

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const o = raw ? JSON.parse(raw) : {};
    const merged = { ...DEFAULTS, ...(o && typeof o === 'object' ? o : {}) };
    // paneWidths is nested, so a stored partial (older shape, or one pane ever
    // dragged) must deep-merge onto the defaults — a shallow spread would drop
    // the panes the user never touched.
    merged.paneWidths = { ...PANE_DEFAULTS, ...(o && typeof o.paneWidths === 'object' ? o.paneWidths : {}) };
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

const SettingsContext = React.createContext(null);

export function useSettings() {
  const ctx = React.useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>');
  return ctx;
}

export function SettingsProvider({ children }) {
  const [settings, setSettings] = React.useState(loadSettings);

  // Mirror `darkMode` onto <html data-theme>, which is what the CSS-variable
  // palette in index.html keys off. The pre-paint script already set this for
  // the initial load; this keeps it in sync on every toggle (and corrects it if
  // localStorage and the script ever disagree).
  React.useEffect(() => {
    document.documentElement.dataset.theme = settings.darkMode ? 'dark' : 'light';
  }, [settings.darkMode]);

  const setSetting = React.useCallback((key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* quota / disabled storage */ }
      return next;
    });
    // One chokepoint for every scalar display toggle — AI-flags on/off, dark/light
    // mode, anonymous mode, the gear-popover switches. (Pane-resize drags go
    // through setPaneWidth and are intentionally NOT logged — far too noisy.)
    logActivity('settings', { key, value });
  }, []);

  // Pane widths change on every pointermove of a drag, so update React state
  // immediately (smooth resize) but coalesce the localStorage write to the
  // trailing edge — no need to hit storage a few hundred times per drag.
  const persistTimer = React.useRef(null);
  const setPaneWidth = React.useCallback((key, value) => {
    setSettings((prev) => {
      const next = { ...prev, paneWidths: { ...prev.paneWidths, [key]: value } };
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* quota / disabled storage */ }
      }, 200);
      return next;
    });
  }, []);

  const value = React.useMemo(
    () => ({ ...settings, settings, setSetting, setPaneWidth }),
    [settings, setSetting, setPaneWidth],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

// `anon(str)` — the anonymous-mode text transform. Identity when the setting is
// OFF (zero cost; the original value, including null / non-strings, passes
// straight through), and the shape-preserving scrambleText when ON. Memoised on
// the flag so it's a stable reference across renders. Every data-text render
// site routes its string through this — either by calling the hook directly
// (`const anon = useAnonymize()`) or via the <Anon> wrapper below. See the
// `anonymize` DEFAULTS comment for exactly what is / isn't covered.
export function useAnonymize() {
  const { anonymize } = useSettings();
  return React.useCallback((s) => (anonymize ? scrambleText(s) : s), [anonymize]);
}

// Convenience wrapper for the common inline case: <Anon>{value}</Anon> renders
// the scrambled (or, when off, original) string. Accepts a single string child;
// for richer content (markdown, nested nodes) call the hook and wrap the source
// string before it's parsed.
export function Anon({ children }) {
  const anon = useAnonymize();
  return <>{anon(children)}</>;
}

// A timestamp display gated by the `showTimestamps` setting. When the setting
// is off it renders nothing — wrap any literal date/time string in this so the
// toggle reaches it. `inline` skips the <L> chrome for use inside an existing
// label (e.g. "<time> · <source>" where source must survive on its own).
export function Stamp({ children, inline = false, ...lprops }) {
  const { showTimestamps } = useSettings();
  if (!showTimestamps) return null;
  if (inline) return <>{children}</>;
  return <L mono {...lprops}>{children}</L>;
}

// A commit-hash display gated by the `showCommitHashes` setting. Short SHAs are
// sprinkled across every list row / header; they default ON since the SHA is
// often the quickest cross-reference back to the trace — wrap any rendered hash
// in this so the toggle reaches it. Pass `sha` (+ optional `len`) for the
// common short-hash case, or
// `text` for a pre-composed string (e.g. a "a … b" range). When the setting is
// off it renders nothing, unless `keepSlot` is set — then it renders an empty
// <L> so a CSS-grid column the hash anchored doesn't collapse and reflow its
// siblings. `useSettings` here too means callers don't each need the hook.
export function Sha({ sha, len = 7, text, fallback = '—', keepSlot = false, ...lprops }) {
  const { showCommitHashes } = useSettings();
  if (!showCommitHashes) return keepSlot ? <L mono {...lprops} /> : null;
  const body = text != null ? text : (sha ? sha.slice(0, len) : fallback);
  return <L mono {...lprops}>{body}</L>;
}

// The "adding a tag flags this <noun>" helper line under each tag editor, gated
// by the `showTagFlagsHint` setting. Defaults OFF (learn-once mechanic — see the
// DEFAULTS comment); renders nothing when off. `noun` fills the trailing word
// ("commit" / "group" / "area"); extra `style` merges onto the line so callers
// can add the spacing the surrounding layout needs.
export function TagFlagsHint({ noun, style }) {
  const { showTagFlagsHint } = useSettings();
  if (!showTagFlagsHint) return null;
  return (
    <L mono size={10} color={WF.ink3} style={{ display: 'block', ...style }}>
      adding a tag flags this {noun}
    </L>
  );
}

// ── Settings gear + popover ────────────────────────────────────────────────
// Lives at the far right of the top bar. A small unobtrusive gear; clicking it
// drops a popover with the available toggles. Closes on outside-click / Escape.
export function SettingsButton() {
  const { showTimestamps, showCommitHashes, showLineNumbers, showAuditEventBox, inboxSubline, inboxTitleFromShortTitle, showTagFlagsHint, anonymize, setSetting } = useSettings();
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        aria-label="settings"
        aria-expanded={open}
        title="display settings"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 24,
          height: 24,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          fontSize: 14,
          lineHeight: 1,
          border: inkBorder(open ? 1.5 : 1.2),
          background: open ? WF.ink : WF.paper,
          color: open ? WF.paper : WF.ink2,
          cursor: 'pointer',
        }}
      >
        ⚙
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 30,
            right: 0,
            zIndex: 1100,
            minWidth: 220,
            padding: '10px 12px',
            background: WF.paper,
            border: inkBorder(1.5),
            boxShadow: `3px 3px 0 ${WF.shadow}`,
          }}
        >
          <L mono size={10} color={WF.ink3} style={{ display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            display
          </L>
          <ToggleRow
            label="show times & dates"
            hint="edit / log-item timestamps"
            checked={showTimestamps}
            onChange={(v) => setSetting('showTimestamps', v)}
          />
          <div style={{ marginTop: 12 }}>
            <ToggleRow
              label="show commit hashes"
              hint="short SHAs on rows / headers"
              checked={showCommitHashes}
              onChange={(v) => setSetting('showCommitHashes', v)}
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <ToggleRow
              label="show line numbers"
              hint="old / new gutter on source diffs"
              checked={showLineNumbers}
              onChange={(v) => setSetting('showLineNumbers', v)}
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <ToggleRow
              label="show audit event box"
              hint="raw audit-event payload on file-edit dossiers"
              checked={showAuditEventBox}
              onChange={(v) => setSetting('showAuditEventBox', v)}
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <SelectRow
              label="inbox subline"
              hint="greyed line under each row"
              value={inboxSubline}
              options={INBOX_SUBLINE_OPTIONS}
              onChange={(v) => setSetting('inboxSubline', v)}
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <ToggleRow
              label="title from short title"
              hint="use the annotation headline as the row title when present"
              checked={inboxTitleFromShortTitle}
              onChange={(v) => setSetting('inboxTitleFromShortTitle', v)}
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <ToggleRow
              label="tag-flags hint"
              hint='show "adding a tag flags this …" under tag editors'
              checked={showTagFlagsHint}
              onChange={(v) => setSetting('showTagFlagsHint', v)}
            />
          </div>
          <div style={{ borderTop: inkBorder(1.2), margin: '10px -12px 0', paddingTop: 10 }} />
          <L mono size={10} color={WF.ink3} style={{ display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            privacy
          </L>
          <ToggleRow
            label="anonymous mode"
            hint="scramble all trace-derived text (code, diffs, annotations) for safe screenshots"
            checked={anonymize}
            onChange={(v) => setSetting('anonymize', v)}
          />
          <div style={{ borderTop: inkBorder(1.2), margin: '10px -12px 0', paddingTop: 10 }} />
          <L mono size={10} color={WF.ink3} style={{ display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            session
          </L>
          <ResetCacheRow onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

// ── AI-suspicion top-bar pill ───────────────────────────────────────────────
// The auditor-facing on/off for the AI suspicion layer: narrator flag levels,
// the overview suspicion sections, flagged semantic areas, the dossier suspect
// filter facet, and the scroll heat-gutter. Defaults OFF (anti-anchoring) — see
// the DEFAULTS comment. It lives in the top bar rather than the gear popover on
// purpose: with the feature dark by default, a buried toggle would leave a fresh
// auditor unaware AI flagging even exists. A segmented off|on (not a lone
// switch) so the live state reads unambiguously at a glance. When on, the "on"
// face fills with the suspicion heat accent — the same red the layer paints with.
export function AiFlagsToggle() {
  const { showAiSuspicion, setSetting } = useSettings();
  const seg = (on, label) => {
    const active = showAiSuspicion === on;
    return (
      <button
        role="radio"
        aria-checked={active}
        aria-label={`AI suspicion flagging ${label}`}
        // Always flip, even when this segment is the active side — clicking
        // anywhere on the pill toggles the layer (with two states, flipping
        // the inactive side still lands on that side's value).
        onClick={() => setSetting('showAiSuspicion', !showAiSuspicion)}
        style={{
          fontFamily: WF.monoFont,
          fontSize: 11,
          padding: '3px 9px',
          border: 'none',
          borderLeft: on ? inkBorder(1.2) : undefined,
          background: active ? (on ? WF.heat4 : WF.ink) : WF.paper,
          // Active text must pair with its fill: `onAccent` (near-white, both
          // modes) on the saturated heat fill, but `paper` on the `ink` fill —
          // `ink`/`paper` invert together, so in dark mode the light ink pill
          // needs dark paper text (onAccent would be near-white-on-near-white).
          color: active ? (on ? WF.onAccent : WF.paper) : WF.ink2,
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      role="radiogroup"
      aria-label="AI suspicion flagging"
      title="AI suspicion flagging — narrator flag levels, the overview suspicion sections, flagged semantic areas, the dossier suspect filter and heat gutter. Off by default so your read of the trace isn't anchored by the model's guesses; flip on to compare."
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
    >
      <L mono size={10} color={WF.ink3} style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>AI flags</L>
      <div style={{ display: 'inline-flex', border: inkBorder(1.2) }}>
        {seg(false, 'off')}
        {seg(true, 'on')}
      </div>
    </div>
  );
}

// ── Theme toggle (top-bar icon) ─────────────────────────────────────────────
// Dark/light flip, surfaced as a single icon-button in the top bar rather than a
// switch row in the gear popover — a one-click affordance that's self-evident at
// a glance. The glyph shows the *current* mode (sun = light, moon = dark); the
// title spells out where a click lands. Sized/bordered to match <SettingsButton>
// so the two sit as a matched pair in <TopBarControls>.
export function ThemeToggle() {
  const { darkMode, setSetting } = useSettings();
  return (
    <button
      aria-label={darkMode ? 'switch to light mode' : 'switch to dark mode'}
      title={darkMode ? 'dark mode — click for light' : 'light mode — click for dark'}
      onClick={() => setSetting('darkMode', !darkMode)}
      style={{
        width: 24,
        height: 24,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        fontSize: 14,
        lineHeight: 1,
        border: inkBorder(1.2),
        background: WF.paper,
        color: WF.ink2,
        cursor: 'pointer',
      }}
    >
      {darkMode ? '🌙' : '🔆'}
    </button>
  );
}

// ── Help / readme button (top-bar icon) ─────────────────────────────────────
// Opens the README, rendered, as a full screen (see WireReadme). It's the
// first-open default and stays one click away here. Sized/bordered to match the
// theme toggle + gear so the three sit as a matched icon group. Fills (active)
// while the help screen is open; clicking it then returns to the timeline.
export function HelpButton() {
  const { screen, goScreen } = useData();
  const active = screen === 'help';
  return (
    <button
      aria-label="help and readme"
      aria-pressed={active}
      title={active ? 'help — click to return to the timeline' : 'help — the README, rendered'}
      onClick={() => goScreen(active ? 'dossier' : 'help')}
      style={{
        width: 24,
        height: 24,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        fontSize: 14,
        lineHeight: 1,
        fontWeight: 700,
        border: inkBorder(active ? 1.5 : 1.2),
        background: active ? WF.ink : WF.paper,
        color: active ? WF.paper : WF.ink2,
        cursor: 'pointer',
      }}
    >
      ?
    </button>
  );
}

// Groups the controls mounted in each screen's AppFrame `rightSlot`: the AI-flags
// pill (the most consequential control, so it leads), then the help / theme /
// settings icons as a matched trio.
export function TopBarControls() {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
      <AiFlagsToggle />
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <HelpButton />
        <ThemeToggle />
        <SettingsButton />
      </div>
    </div>
  );
}

// "Reset cache" — clears the auditor's accumulated session state: visited
// marks, user flags, notes (across all traces, in localStorage), and the live
// navigation position. Two-step (click → confirm) so an errant click can't wipe
// a session's markups. Lives in its own settings section because it acts on the
// trace store, not a display preference.
function ResetCacheRow({ onDone }) {
  const { resetCache } = useData();
  const [armed, setArmed] = React.useState(false);

  // Disarm if the user moves focus away without confirming.
  const handleBlur = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setArmed(false);
  };

  return (
    <div onBlur={handleBlur} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <L size={13} style={{ display: 'block' }}>reset cache</L>
        <L mono size={10} color={WF.ink3} style={{ display: 'block', marginTop: 1 }}>
          visited · flags · notes · history
        </L>
      </span>
      {armed ? (
        <button
          onClick={() => { resetCache(); setArmed(false); onDone?.(); }}
          style={{
            flexShrink: 0,
            padding: '4px 10px',
            fontFamily: WF.bodyFont,
            fontSize: 12,
            border: inkBorder(1.5),
            background: WF.ink,
            color: WF.paper,
            cursor: 'pointer',
          }}
        >
          confirm
        </button>
      ) : (
        <button
          onClick={() => setArmed(true)}
          style={{
            flexShrink: 0,
            padding: '4px 10px',
            fontFamily: WF.bodyFont,
            fontSize: 12,
            border: inkBorder(1.2),
            background: WF.paper,
            color: WF.ink,
            cursor: 'pointer',
          }}
        >
          reset
        </button>
      )}
    </div>
  );
}

// A labelled select-one control. The label/hint sit on the left (matching
// ToggleRow); the right is a small set of segmented buttons, one per option,
// with the active value filled ink. Keeps the popover keyboard/click simple
// without pulling in a native <select>'s styling quirks.
function SelectRow({ label, hint, value, options, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ minWidth: 0 }}>
        <L size={13} style={{ display: 'block' }}>{label}</L>
        {hint && <L mono size={10} color={WF.ink3} style={{ display: 'block', marginTop: 1 }}>{hint}</L>}
      </span>
      <div role="radiogroup" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              role="radio"
              aria-checked={active}
              title={opt.hint || opt.label}
              onClick={() => onChange(opt.value)}
              style={{
                padding: '3px 8px',
                fontFamily: WF.bodyFont,
                fontSize: 12,
                border: inkBorder(active ? 1.5 : 1.2),
                background: active ? WF.ink : WF.paper,
                color: active ? WF.paper : WF.ink2,
                cursor: 'pointer',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// A labelled switch. Monochrome track + ink knob to match the wireframe look.
function ToggleRow({ label, hint, checked, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <L size={13} style={{ display: 'block' }}>{label}</L>
        {hint && <L mono size={10} color={WF.ink3} style={{ display: 'block', marginTop: 1 }}>{hint}</L>}
      </span>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        style={{
          position: 'relative',
          width: 34,
          height: 18,
          flexShrink: 0,
          padding: 0,
          border: inkBorder(1.2),
          background: checked ? WF.ink : WF.paper,
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: checked ? 17 : 1,
            width: 14,
            height: 14,
            background: checked ? WF.paper : WF.ink,
            transition: 'left 90ms ease',
          }}
        />
      </button>
    </label>
  );
}
