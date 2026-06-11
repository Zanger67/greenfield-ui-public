// Shared wireframe primitives — Balsamiq-ish monochrome boxes with a single
// red-heat accent for suspicion. Ported from the design handoff bundle:
// ink strokes, handwritten headings, mono for code/labels, no SVG icons —
// [bracket] mono tags as placeholders instead.
import React from 'react';
import { logActivity } from './activityLog.js';

// Colours are CSS custom properties, not literal hex — the actual light/dark
// values live in index.html under :root / :root[data-theme="dark"]. Because
// every component reads `WF.x` at render time and gets a `var(--wf-x)` string,
// flipping `data-theme` on <html> re-themes the whole app live, with no React
// re-render and no import-time-capture pitfalls (a captured `var(--wf-x)`
// string still resolves to the current theme's value in the DOM). The dark
// palette + the `darkMode` toggle are wired in settings.jsx; light values are
// byte-identical to the original palette. Fonts stay literal — not themed.
export const WF = {
  paper: 'var(--wf-paper)',
  ink: 'var(--wf-ink)',
  ink2: 'var(--wf-ink2)',
  ink3: 'var(--wf-ink3)',
  rule: 'var(--wf-rule)',
  rule2: 'var(--wf-rule2)',
  visited: 'var(--wf-visited)',
  paperAlt: 'var(--wf-paperAlt)',
  heat0: 'var(--wf-heat0)',
  heat1: 'var(--wf-heat1)',
  heat2: 'var(--wf-heat2)',
  heat3: 'var(--wf-heat3)',
  heat4: 'var(--wf-heat4)',
  // Near-white text that punches out of a *filled accent* fill (heat / theme
  // chips). Stays light in both themes, unlike `paper` which inverts dark — use
  // this, not `paper`, for `color=` on a saturated `bg=`. See index.html.
  onAccent: 'var(--wf-onAccent)',
  // The auditor's own "user flagged" accent — orange, distinct from the red
  // AI-suspicion heat and the neutral ink chips.
  userflag: 'var(--wf-userflag)',
  // Foreground green for "+adds" diff counts (dels reuse `heat4`).
  add: 'var(--wf-add)',
  // Faint warm highlight behind an active suspicion item.
  tint: 'var(--wf-tint)',
  // Element-edge stroke (used by inkBorder) and the hard offset drop-shadow.
  // Equal to `ink` in light; softened in dark so panel edges / shadows don't
  // glare near-white. Use `border` for dividers/outlines, `shadow` for the
  // `Npx Npx 0` sticker shadows. (Inset "you-are-here" cursor bars stay `ink`.)
  border: 'var(--wf-border)',
  shadow: 'var(--wf-shadow)',
  // Dossier surfaces that the first dark pass missed: warm row/lift highlight
  // (`mark`), the cool "what's being done" annotation panel (`panel`), and the
  // per-flag row tints (`rowHigh` / `rowMed`).
  mark: 'var(--wf-mark)',
  panel: 'var(--wf-panel)',
  rowHigh: 'var(--wf-row-high)',
  rowMed: 'var(--wf-row-med)',
  // Tag/chip families — a subtle `Bg` fill paired with a readable `Fg` label,
  // keyed by hue. Drive the dossier's KIND / FILECLASS / FLAG / ACTIVITY style
  // maps and the diff line backgrounds. Light = the original literals; dark =
  // muted fill + bright label so chips read on the dark surface.
  tagGreenBg: 'var(--wf-tag-green-bg)',   tagGreenFg: 'var(--wf-tag-green-fg)',
  tagAmberBg: 'var(--wf-tag-amber-bg)',   tagAmberFg: 'var(--wf-tag-amber-fg)',
  tagRedBg: 'var(--wf-tag-red-bg)',       tagRedFg: 'var(--wf-tag-red-fg)',
  tagPurpleBg: 'var(--wf-tag-purple-bg)', tagPurpleFg: 'var(--wf-tag-purple-fg)',
  tagBlueBg: 'var(--wf-tag-blue-bg)',     tagBlueFg: 'var(--wf-tag-blue-fg)',
  tagSlateBg: 'var(--wf-tag-slate-bg)',   tagSlateFg: 'var(--wf-tag-slate-fg)',
  // Categorical semantic-area accents (consumed via THEME_COLOR).
  catData: 'var(--wf-cat-data)',
  catBlue: 'var(--wf-cat-blue)',
  catPurple: 'var(--wf-cat-purple)',
  catAmber: 'var(--wf-cat-amber)',
  catSlate: 'var(--wf-cat-slate)',
  catBlueGrey: 'var(--wf-cat-bluegrey)',
  headFont: '"Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", sans-serif',
  bodyFont: '"Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", sans-serif',
  monoFont: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
};

export const heat = (n) => [WF.heat0, WF.heat1, WF.heat2, WF.heat3, WF.heat4][Math.max(0, Math.min(4, n))];

export const inkBorder = (w = 1.5) => `${w}px solid ${WF.border}`;

// ── Anonymous-mode text scramble ────────────────────────────────────────────
// Shape-preserving de-identification for the `anonymize` setting (settings.jsx).
// Every letter is replaced with a pseudo-random letter (case kept) and every
// digit with a pseudo-random digit; whitespace, punctuation, and all other
// glyphs pass through verbatim. That last rule is what makes a whole-string
// scramble safe to apply blindly: the diff `+`/`-`/`@@` gutters, markdown
// `**`/`` ` ``/`#` markers, code indentation and operators, and path separators
// are all non-alphanumeric, so they survive — scrambled code still reads as
// code, a scrambled path still reads as a path, scrambled markdown still
// renders bold/lists/headings.
//
// The mapping is DETERMINISTIC in (charCode, position): the same input always
// produces the same output, so there is no shimmer across re-renders and an
// identical string (e.g. a file path shown in a row and again in a diff header)
// scrambles to the same thing everywhere. It is a privacy screen for
// screenshots / screen-shares / external demos, NOT a cipher — it only has to
// stop a real name, path, or code line from being read off the screen. The
// underlying data is never touched (this runs at render time), so navigation,
// git lookups, filters, and the AI_AUDIT.md export keep working on real values.
const SCRAMBLE_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const SCRAMBLE_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SCRAMBLE_DIGITS = '0123456789';

export function scrambleText(input) {
  if (input == null) return input;
  const str = String(input);
  let out = '';
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    // A small integer hash of (charCode, index) → a stable pseudo-random pick.
    // The trailing `>>> 0` is load-bearing: `^` yields a SIGNED int32, so without
    // it `h % 26` could go negative and index past the alphabet (→ undefined,
    // which would also break length preservation). Coerce back to unsigned first.
    let h = (Math.imul(c, 2654435761) + Math.imul(i + 1, 40503) + 0x9e3779b9) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
    h >>>= 0;
    if (c >= 97 && c <= 122) out += SCRAMBLE_LOWER[h % 26];        // a–z
    else if (c >= 65 && c <= 90) out += SCRAMBLE_UPPER[h % 26];    // A–Z
    else if (c >= 48 && c <= 57) out += SCRAMBLE_DIGITS[h % 10];   // 0–9
    else out += str[i];                                            // keep verbatim
  }
  return out;
}

export function L({ children, size = 13, mono = false, color, style = {}, weight = 400, onClick, title, id }) {
  // onClick / title are forwarded: several call sites style an <L> as a link
  // (cursor:pointer, dotted underline) and pass onClick to navigate — e.g. the
  // "open →" commit link and the auditor-comment labels on the areas screen.
  // Without forwarding, those handlers were silently dropped and the links did
  // nothing. title drives the hover tooltips a few <L>s ask for. `id` lets a
  // heading carry a slug anchor so in-page `#…` Markdown links can scroll to it.
  return (
    <span
      id={id}
      onClick={onClick}
      title={title}
      style={{
        fontFamily: mono ? WF.monoFont : WF.bodyFont,
        fontSize: size,
        fontWeight: weight,
        color: color || WF.ink,
        lineHeight: 1.25,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// Minimal inline-markdown renderer for SDK-agent-authored commentary:
// `inline code`, ***bold italic***, **bold**, and *italic*. Asterisks only.
// Underscores are NEVER italic — they are everywhere in file and identifier names
// (my_module.py, learning_rate), so `_` is always literal. Returns React children
// to drop inside an <L> (color / size inherited via CSS). Bold/italic nest; the
// content of an inline-code span is VERBATIM — `*`, `**`, and backticks inside it
// are not parsed. Anything unrecognized — a lone `*`, an unclosed `` ` `` — is left
// as plain text, so malformed markup degrades to raw characters rather than
// disappearing.
//
// The one block construct it does handle is a fenced ```…``` code block (opened
// only at the start of a line, content verbatim, rendered as a `display: block`
// span-safe <code>); headings, styled lists, and links are still left to the
// block-level `Markdown` component below.
// Line breaks ARE meaningful: the container <L> sets whiteSpace: 'pre-wrap', so
// newlines render and an agent can lay out a manual list by starting lines with
// "- ", "1. ", etc. — the markers stay literal but read as a list. Emphasis only
// opens when the marker is immediately followed by non-space and (for single-* and
// triple-* spans) does not cross a newline, so a "* bullet" line is never mistaken
// for italics.
const mdCodeStyle = {
  fontFamily: WF.monoFont,
  fontSize: '0.92em',
  background: WF.paperAlt,
  border: `1px solid ${WF.rule}`,
  borderRadius: 3,
  padding: '0 3px',
  // Preserve internal spacing of a code span even when the surrounding block
  // collapses whitespace (the block Markdown paragraphs use white-space: normal
  // for CommonMark soft-break behaviour — see MdBlock).
  whiteSpace: 'pre-wrap',
};

// Fenced (```) block inside the inline flow. Rendered as a `display: block`
// <code> (phrasing content, so it stays valid inside the host <span>) rather
// than a <pre>, with `pre`/overflow so long lines scroll instead of wrapping.
const mdFenceStyle = {
  display: 'block',
  fontFamily: WF.monoFont,
  fontSize: '0.92em',
  background: WF.paperAlt,
  border: `1px solid ${WF.rule}`,
  borderRadius: 3,
  padding: '6px 8px',
  margin: '4px 0',
  whiteSpace: 'pre',
  overflowX: 'auto',
  lineHeight: 1.5,
};

// `opts.links` opts into `[text](href)` link parsing (off by default, so the
// agent-commentary callers are unchanged and a bracket in a comment stays
// literal). The block-level `Markdown` passes it on, with an optional
// `opts.onLink(href)` the host uses to intercept navigation (e.g. the help page
// opening AGENTS.md in-app). `![…](…)` images are left to the block layer, so a
// `[` preceded by `!` is skipped here.
export function renderInline(text, keyPrefix = 'md', opts = null) {
  if (text == null) return text;
  const str = String(text);
  const nodes = [];
  let buf = '';
  let i = 0;
  let key = 0;
  const flush = () => { if (buf) { nodes.push(buf); buf = ''; } };

  while (i < str.length) {
    const rest = str.slice(i);
    // A fence only opens at the start of a (possibly indented) line, so a stray
    // ``` mid-sentence falls through to the single-backtick / literal paths.
    const lineStart = i === 0 || str[i - 1] === '\n';
    let m;
    if (lineStart && (m = /^```[^\n]*\n([\s\S]*?)(?:\n[ \t]*```[ \t]*(?=\n|$)|$)/.exec(rest))) {
      // Fenced code block: body is VERBATIM (no bold/italic/inline-code re-parse)
      // and spans newlines. An unclosed fence runs to the end of the string —
      // matching the block-level Markdown parser rather than dropping the text.
      flush();
      nodes.push(<code key={`${keyPrefix}-${key++}`} style={mdFenceStyle}>{m[1]}</code>);
    } else if ((m = /^`([^`\n]+)`/.exec(rest))) {
      // Inline code: content is verbatim — never re-parsed for bold/italic.
      flush();
      nodes.push(<code key={`${keyPrefix}-${key++}`} style={mdCodeStyle}>{m[1]}</code>);
    } else if ((m = /^\*\*\*(?!\s)([^\n]+?)\*\*\*/.exec(rest))) {
      flush();
      nodes.push(
        <strong key={`${keyPrefix}-${key++}`}><em>{renderInline(m[1], `${keyPrefix}-${key}bi`, opts)}</em></strong>
      );
    } else if ((m = /^\*\*(?!\s)([\s\S]+?)\*\*/.exec(rest))) {
      flush();
      nodes.push(<strong key={`${keyPrefix}-${key++}`}>{renderInline(m[1], `${keyPrefix}-${key}b`, opts)}</strong>);
    } else if ((m = /^\*(?!\s)([^*\n]+?)\*/.exec(rest))) {
      flush();
      nodes.push(<em key={`${keyPrefix}-${key++}`}>{renderInline(m[1], `${keyPrefix}-${key}i`, opts)}</em>);
    } else if (opts?.links && str[i - 1] !== '!' && (m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      // Inline link `[label](href)`. The label keeps inline emphasis; the host's
      // onLink (if any) decides what the href does.
      flush();
      nodes.push(
        <MdLink key={`${keyPrefix}-${key++}`} href={m[2]} onLink={opts.onLink}>
          {renderInline(m[1], `${keyPrefix}-${key}lk`, opts)}
        </MdLink>
      );
    } else {
      buf += str[i];
      i += 1;
      continue;
    }
    i += m[0].length;
  }
  flush();
  return nodes.length === 1 && typeof nodes[0] === 'string' ? nodes[0] : nodes;
}

export function Box({ children, style = {}, heat: h, dim, thick = 1.5, rot = 0, onClick, tag = 'div' }) {
  const T = tag;
  return (
    <T
      onClick={onClick}
      style={{
        border: inkBorder(thick),
        background: dim ? WF.paperAlt : (typeof h === 'number' ? heat(h) : WF.paper),
        padding: 8,
        position: 'relative',
        boxSizing: 'border-box',
        transform: rot ? `rotate(${rot}deg)` : undefined,
        opacity: dim ? 0.4 : 1,
        cursor: onClick ? 'pointer' : undefined,
        ...style,
      }}
    >
      {children}
    </T>
  );
}

// Lay a set of panels out as tiles: at most two per row, side by side and
// equal-height, with a trailing odd one spanning the full width on its own row.
// Falsy children (a panel gated off with `cond && <Panel/>`) are dropped first,
// so the pairing reflects only what's actually present. Each kept child is
// cloned with `flex: 1, minWidth: 0` merged into its style, so every child must
// forward `style` to its root element (the panel components here all do).
export function Tiles({ children, gap = 12 }) {
  const items = React.Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  const rows = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {rows.map((row, ri) => (
        <div key={ri} style={{ display: 'flex', gap, alignItems: 'stretch' }}>
          {row.map((child) =>
            React.cloneElement(child, {
              style: { ...(child.props.style || {}), flex: 1, minWidth: 0 },
            }),
          )}
        </div>
      ))}
    </div>
  );
}

export function Chip({ children, color = WF.ink, bg, style = {}, ...rest }) {
  return (
    <span
      {...rest}
      style={{
        fontFamily: WF.monoFont,
        fontSize: 10,
        fontWeight: 500,
        color,
        background: bg || 'transparent',
        border: `1px solid ${color}`,
        padding: '1px 5px',
        borderRadius: 2,
        whiteSpace: 'nowrap',
        letterSpacing: 0.2,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// Copy text to the clipboard with a transient `copied` flag. `text` may be a
// string or a () => string thunk resolved at click time (so a heading can build
// its reference statement lazily from live state). Falls back to a hidden
// <textarea> + execCommand for non-secure dev contexts where navigator.clipboard
// is absent. Returns { copied, copy }; `copy` stops event propagation so it's
// safe on a nested control.
export function useCopy(text, holdMs = 1300) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef(null);
  const copy = React.useCallback((e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    const value = typeof text === 'function' ? text() : text;
    const mark = () => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), holdMs);
    };
    // The single chokepoint for every copy-to-clipboard affordance (the handoff
    // CopyBlock, CopyTitle/Tag/Text reference copies). Record that a copy happened
    // and a short preview — not the whole payload, which can be a large diff/ref.
    logActivity('copy', { chars: (value || '').length, preview: String(value || '').slice(0, 80) });
    try {
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(mark, mark);
      else throw new Error('no clipboard');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = value; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta); mark();
      } catch { /* give up silently */ }
    }
  }, [text, holdMs]);
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { copied, copy };
}

// Leading frame on every paste-ready handoff prompt, so a coding agent knows the
// line it's reading is a pointer handed off from the trace's audit UI (not the
// human typing free-form). Single source of truth — `refStatement` and the
// WireSemanticAreas CopyBlock prompts all lead with it; tweak the wording here.
export const UI_HANDOFF_PREFIX = "Investigation context from the trace's audit UI. ";

// One short clause — placed right after UI_HANDOFF_PREFIX in every handoff prompt
// — naming the trace and where its files sit on disk, so the coding agent knows
// which dir to resolve the pointer against. `trace` is the manifest entry
// ({ name, source }) from the store's `currentTrace`: source 'parent' means the
// surrounding trace served from ../, anything else means public/data/<name>/
// (the same convention AGENTS.md uses). Returns '' if no trace is known.
export function traceLocation(trace) {
  if (!trace || !trace.name) return '';
  const loc = trace.source === 'parent' ? '../ (relative to the ui dir)' : `public/data/${trace.name}/`;
  return `Trace ${trace.name} at ${loc}. `;
}

// Compose a compact, paste-ready *pointer* for handing one target off to a coding
// agent. It carries the audit-store `target_key` (the join key into <trace>/audit/),
// NOT the target's annotations — and, for a multi-commit target (thread / area /
// sidecar group), NOT the commit-hash dump either. The agent resolves the members,
// the hashes, and the auditor's notes by following the pointer; the *how* (the
// `expand(anchor)` procedure, which jsonl files to read, the jq queries) lives in
// AGENTS.md, deliberately kept out of this prompt so it stays short. A single commit
// also carries its `inner_commit_sha` inline.
export function refStatement({ kind, label, targetKey, sha = null, single = false, detail = null, trace = null }) {
  const ptr = targetKey ? ` — audit pointer ${targetKey}` : '';
  const git = single && sha ? ` · inner_commit_sha ${sha}` : '';
  // For a group handoff, `detail` carries its scope at a glance — type, commit
  // count, first…last sha — so the agent can confirm it resolved the right thing.
  const det = detail ? ` · ${detail}` : '';
  return `${UI_HANDOFF_PREFIX}${traceLocation(trace)}${kind} "${label}"${ptr}${git}${det}. Resolve it via the schema in the UI's AGENTS.md.`;
}

// A monospace, copy-to-clipboard block: clicking the text OR the corner button
// copies `text`; both flash a "copied ✓" confirmation. Used for paste-ready
// snippets (e.g. the group-handoff prompt) the auditor drops into Claude Code.
export function CopyBlock({ text, label = 'copy', title = 'click to copy', size = 11.5, italic = false, style = {} }) {
  const { copied, copy } = useCopy(text);
  return (
    <div
      onClick={copy}
      title={title}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(e); } }}
      style={{
        position: 'relative', cursor: 'pointer', background: WF.paperAlt,
        border: inkBorder(1.2), borderColor: copied ? WF.add : WF.border,
        padding: '9px 10px', paddingRight: 64, transition: 'border-color 0.15s',
        ...style,
      }}
    >
      <code style={{
        fontFamily: WF.monoFont, fontSize: size, lineHeight: 1.5, color: WF.ink2,
        fontStyle: italic ? 'italic' : 'normal',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', display: 'block',
      }}>{text}</code>
      <Chip
        onClick={copy}
        color={copied ? WF.add : WF.ink2}
        bg={WF.paper}
        style={{ position: 'absolute', top: 7, right: 7, cursor: 'pointer' }}
      >{copied ? 'copied ✓' : label}</Chip>
    </div>
  );
}

// A heading that copies a reference statement when clicked. The visible text is
// the title; `copyText` (string or thunk) is the paste-ready statement. A subtle
// "copy refs" hint fades in on hover, swapped for "copied ✓" after a click. Use
// on static titles (commit / area / thread); an editable title (e.g. a user
// group's rename field) relies on its handoff CopyBlock instead.
export function CopyTitle({ children, copyText, size = 18, weight = 700, mono = false, color = WF.ink, hint = '⧉ copy refs', title = 'click to copy references', style = {} }) {
  const { copied, copy } = useCopy(copyText);
  const [hover, setHover] = React.useState(false);
  return (
    <span
      onClick={copy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(e); } }}
      style={{
        display: 'inline-flex', alignItems: 'baseline', gap: 8, cursor: 'pointer',
        fontFamily: mono ? WF.monoFont : WF.bodyFont, fontSize: size, fontWeight: weight,
        color, lineHeight: 1.25, ...style,
      }}
    >
      <span>{children}</span>
      <span style={{
        fontFamily: WF.monoFont, fontSize: Math.max(9, Math.round(size * 0.55)), fontWeight: 500,
        fontStyle: 'normal', whiteSpace: 'nowrap', color: copied ? WF.add : WF.ink3,
        opacity: copied || hover ? 1 : 0, transition: 'opacity 0.12s',
      }}>{copied ? 'copied ✓' : hint}</span>
    </span>
  );
}

// A classification Chip that doubles as a copy-references affordance: clicking the
// badge copies the same paste-ready statement a CopyTitle would, so the auditor
// can grab a target's refs from its "▦ data commit group" / "▣ data" / "~ modify"
// classification as well as its title. Keeps the badge's own semantic fill
// (passed through `style`); flashes the border to WF.add on copy as confirmation.
export function CopyTag({ children, copyText, title = 'click to copy references', style = {} }) {
  const { copied, copy } = useCopy(copyText);
  return (
    <Chip
      onClick={copy}
      title={copied ? 'copied ✓' : title}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(e); } }}
      style={{ cursor: 'pointer', transition: 'border-color 0.15s', ...style, ...(copied ? { borderColor: WF.add } : {}) }}
    >{children}</Chip>
  );
}

// A plain clickable text line that copies `copyText` on click, flashing its own
// ink to WF.add as confirmation. Unlike CopyTitle it adds no hover hint, so it
// suits a describing subline or a metadata label (e.g. the "audit" / "commands"
// source word) that should copy the same reference as its header's title but
// confirm on its own line only — each instance owns its flash.
export function CopyText({ children, copyText, size = 13, mono = false, weight = 400, color = WF.ink2, title = 'click to copy references', style = {} }) {
  const { copied, copy } = useCopy(copyText);
  return (
    <L
      mono={mono}
      size={size}
      weight={weight}
      color={copied ? WF.add : color}
      onClick={copy}
      title={copied ? 'copied ✓' : title}
      style={{ cursor: 'pointer', transition: 'color 0.15s', ...style }}
    >{children}</L>
  );
}

export function Rule({ color = WF.rule, w = '100%', h = 1.5, style = {} }) {
  return <div style={{ width: w, height: h, background: color, ...style }} />;
}

export function Placeholder({ w = '100%', h = 120, label = 'placeholder', style = {} }) {
  const stripe = `repeating-linear-gradient(-45deg, ${WF.rule} 0 1px, transparent 1px 10px)`;
  return (
    <div
      style={{
        width: w,
        height: h,
        border: inkBorder(),
        background: stripe,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...style,
      }}
    >
      <span
        style={{
          fontFamily: WF.monoFont,
          fontSize: 11,
          color: WF.ink2,
          background: WF.paper,
          padding: '2px 6px',
          border: `1px solid ${WF.rule2}`,
        }}
      >
        {label}
      </span>
    </div>
  );
}

// Three pulsing dots — the "… is working" tell. Staggered animation-delay
// makes the dots ripple left→right; keyframes (`wf-dots`) live in index.html.
export function Dots({ color = WF.ink3, size = 6, gap }) {
  const dot = (delay) => ({
    width: size,
    height: size,
    borderRadius: '50%',
    background: color,
    display: 'inline-block',
    animation: 'wf-dots 1.2s ease-in-out infinite',
    animationDelay: delay,
  });
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: gap ?? size * 0.7 }}>
      <span className="wf-dot" style={dot('0s')} />
      <span className="wf-dot" style={dot('0.18s')} />
      <span className="wf-dot" style={dot('0.36s')} />
    </span>
  );
}

// Greyed-out placeholder box for in-flight git/diff work. Dashed muted border,
// paperAlt fill, a mono label, and the animated Dots so it reads as "loading,
// not empty" at a glance. `height` pins a min-height so the box doesn't
// collapse before content arrives.
export function LoadingBox({ label = 'loading', height, color = WF.ink3, style = {} }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        border: `1.5px dashed ${WF.rule2}`,
        background: WF.paperAlt,
        color,
        fontFamily: WF.monoFont,
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: '14px 16px',
        minHeight: height,
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {label && <span>{label}</span>}
      <Dots color={color} />
    </div>
  );
}

export function HeatDot({ n = 0, size = 10 }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: heat(n),
        border: `1px solid ${WF.ink}`,
        display: 'inline-block',
        verticalAlign: 'middle',
      }}
    />
  );
}

export function Check({ on }) {
  return (
    <span
      style={{
        width: 12,
        height: 12,
        border: `1.5px solid ${WF.ink}`,
        display: 'inline-block',
        verticalAlign: 'middle',
        fontFamily: WF.monoFont,
        fontSize: 12,
        lineHeight: '10px',
        textAlign: 'center',
        color: WF.ink,
        background: on ? WF.ink : 'transparent',
      }}
    >
      {on ? <span style={{ color: WF.paper, fontSize: 10, fontWeight: 700 }}>✓</span> : ''}
    </span>
  );
}

export function Arrow({ x1, y1, x2, y2, dashed, label, color = WF.ink, thick = 1.5 }) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const ang = Math.atan2(dy, dx);
  const hx = x2 - Math.cos(ang) * 8;
  const hy = y2 - Math.sin(ang) * 8;
  const lx = (x1 + x2) / 2;
  const ly = (y1 + y2) / 2;
  // stroke/fill go through `style`, not the SVG presentation attributes —
  // `var(--wf-*)` colours only resolve via CSS, not as raw attribute values.
  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        style={{ stroke: color }}
        strokeWidth={thick}
        strokeDasharray={dashed ? '4 3' : undefined}
        strokeLinecap="round"
      />
      <polygon
        points={`${x2},${y2} ${hx - Math.sin(ang) * 4},${hy + Math.cos(ang) * 4} ${hx + Math.sin(ang) * 4},${hy - Math.cos(ang) * 4}`}
        style={{ fill: color }}
      />
      {label && (
        <text x={lx} y={ly - 4} fontSize="10" fontFamily={WF.monoFont} style={{ fill: color }} textAnchor="middle">
          {label}
        </text>
      )}
    </g>
  );
}

// Coverage counter pill. visited = x/y chunks seen. The suspicion-seen
// percentage/fraction segment has been removed: it stayed hidden while AI
// flagging was off, and is now dropped when on as well, so only the visited
// count remains. `susSeen`/`susTotal`/`showSuspicion` are still accepted (and
// ignored) so existing callers don't break.
export function Coverage({ visited = 16, total = 48, susSeen = 3.2, susTotal = 21.7, showSuspicion = true, style = {} }) {
  return (
    <div
      style={{
        border: inkBorder(),
        padding: '6px 10px',
        background: WF.paper,
        fontFamily: WF.monoFont,
        fontSize: 11,
        display: 'inline-flex',
        gap: 10,
        alignItems: 'center',
        ...style,
      }}
    >
      <span>
        visited <b style={{ fontWeight: 700 }}>{visited}/{total}</b>
      </span>
    </div>
  );
}

// Top bar integrates the screen-picker tabs (replacing the old
// REDLOGS / V1 static title) so switching screens happens inside the
// surface chrome, not above it. `topBar` is expected to render tabs.
export function AppFrame({ topBar, subtitle, children, coverage = true, coverageProps, rightSlot, style = {} }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: WF.paper,
        color: WF.ink,
        fontFamily: WF.bodyFont,
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      <div style={{ borderBottom: inkBorder(), padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        {topBar}
        {subtitle && <L size={12} color={WF.ink3} mono>{subtitle}</L>}
        <div style={{ flex: 1 }} />
        {coverage && <Coverage {...(coverageProps || {})} />}
        {rightSlot}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

// Draggable splitter for resizable panes. Renders the divider line itself (so
// the pane it sits next to should NOT also draw a border on this edge),
// thickening and turning heat-red on hover / drag. `axis` picks the drag
// direction: 'x' (default) splits side-by-side columns and resizes width; 'y'
// splits stacked rows and resizes height. `width`/`setWidth` own the resized
// pane's size along that axis (named for the common horizontal case); `dir` is
// +1 when the handle sits on the pane's *trailing* edge — right (x) / bottom
// (y), so dragging toward it grows the pane — and -1 on the *leading* edge
// (left / top). Clamping lives here; the parent just stores the number. `max`
// may be a number or a thunk returning one, so a caller can supply a dynamic
// ceiling (e.g. a % of a container measured at drag time). Pointer capture
// keeps the drag alive when the cursor leaves the thin strip, and the body
// cursor/selection is pinned for the duration so a fast drag doesn't select
// page text. Double-click resets to `dflt` when provided.
export function PaneResizer({ width, setWidth, min = 160, max = 900, dir = 1, dflt, axis = 'x' }) {
  const [active, setActive] = React.useState(false);
  const [hover, setHover] = React.useState(false);
  const drag = React.useRef(null);
  const vertical = axis === 'y';
  const resizeCursor = vertical ? 'row-resize' : 'col-resize';
  const clampMax = () => (typeof max === 'function' ? max() : max);

  const pinBody = (on) => {
    document.body.style.userSelect = on ? 'none' : '';
    document.body.style.cursor = on ? resizeCursor : '';
  };
  const onPointerDown = (e) => {
    e.preventDefault();
    drag.current = { start: vertical ? e.clientY : e.clientX, startW: width };
    setActive(true);
    pinBody(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const pos = vertical ? e.clientY : e.clientX;
    const next = drag.current.startW + (pos - drag.current.start) * dir;
    setWidth(Math.max(min, Math.min(clampMax(), Math.round(next))));
  };
  const end = (e) => {
    if (!drag.current) return;
    drag.current = null;
    setActive(false);
    pinBody(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* unsupported */ }
  };

  const lit = active || hover;
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onDoubleClick={dflt != null ? () => setWidth(dflt) : undefined}
      title={dflt != null ? 'drag to resize · double-click to reset' : 'drag to resize'}
      style={{
        flexShrink: 0,
        display: 'flex',
        cursor: resizeCursor,
        background: active ? WF.heat0 : 'transparent',
        touchAction: 'none',
        userSelect: 'none',
        ...(vertical
          ? { width: '100%', height: 7, alignItems: 'center' }
          : { alignSelf: 'stretch', width: 7, justifyContent: 'center' }),
      }}
    >
      <div
        style={{
          background: active ? WF.heat4 : hover ? WF.heat3 : WF.ink,
          ...(vertical
            ? { height: lit ? 3 : 1.5, width: '100%', transition: 'height 90ms ease, background 90ms ease' }
            : { width: lit ? 3 : 1.5, height: '100%', transition: 'width 90ms ease, background 90ms ease' }),
        }}
      />
    </div>
  );
}

// Pure viz primitive. `heats` is 0..4 per cell; cursor highlights the
// active cell with an ink border; `related` (set of indices) marks cells
// connected to the cursor via relation — they get a red border so an
// auditor can see at a glance which chunks are involved with the current
// one without leaving the timeline strip.
export function MiniTimeline({ heats = [], cursor = 0, visited = [], related, style = {}, tall = 16, onPick, titleFor }) {
  const relatedSet = related instanceof Set ? related : new Set(related || []);
  const visitedSet = new Set(visited);
  return (
    <div style={{ display: 'flex', gap: 1, ...style }}>
      {heats.map((h, i) => {
        let border;
        if (i === cursor) border = `2px solid ${WF.ink}`;
        else if (relatedSet.has(i)) border = `2px solid ${WF.heat4}`;
        else border = `1px solid ${WF.rule}`;
        return (
          <div
            key={i}
            onClick={() => onPick && onPick(i)}
            title={titleFor ? titleFor(i) : undefined}
            style={{
              flex: 1,
              height: tall,
              background: heat(h),
              border,
              opacity: visitedSet.has(i) ? 0.4 : 1,
              cursor: onPick ? 'pointer' : 'default',
            }}
          />
        );
      })}
    </div>
  );
}

// ── Block-level Markdown ──────────────────────────────────────────────────
// `renderInline` (above) is deliberately inline-only — emphasis and code spans
// for agent commentary. The trace's document artifacts (final report, blue-team
// report, experiment description, guide) are full Markdown files, so `Markdown`
// adds the block layer on top of it: ATX headings, unordered/ordered lists,
// fenced code, blockquotes, horizontal rules, standalone images, and
// paragraphs. It is NOT a CommonMark engine — it covers the constructs these
// hand-/agent-authored docs actually use and degrades anything unrecognized to
// a plain paragraph (so a stray construct shows as raw text, never vanishes).
// Inline emphasis inside every block still flows through `renderInline`, so the
// underscore-is-literal / asterisk-only rules hold here too.
//
// A GFM table separator row: `| --- | :---: | ---: |` — pipes around cells of
// dashes with optional leading/trailing colons (alignment). Used to confirm the
// line *above* is a header row before committing to table parsing.
const mdTableSep = (s) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(s);
// Split one table row into trimmed cells, dropping the optional outer pipes.
// Plain split on `|` (no escaped-pipe handling) — fine for the trace docs and
// this app's README, none of which carry literal pipes inside a cell.
const mdSplitRow = (s) => {
  let t = s.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
};

// `resolveImg(src)` maps a relative image path to a URL (e.g. into the trace's
// data dir). Without it, an image renders its src verbatim. Most trace docs
// reference figures as backticked filenames rather than `![](…)` image syntax,
// so the resolver is a courtesy for the docs that do embed images.
function parseMdBlocks(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flushPara = () => {
    if (para.length) { blocks.push({ type: 'para', text: para.join('\n') }); para = []; }
  };
  const listRe = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code: opening ``` consumes verbatim up to the next closing fence
    // (or EOF), so nothing inside is reparsed as Markdown.
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      flushPara();
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // step past the closing fence (a no-op at EOF)
      blocks.push({ type: 'code', lines: body });
      continue;
    }
    if (/^\s*$/.test(line)) { flushPara(); i += 1; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() }); i += 1; continue; }
    // Horizontal rule (--- / *** / ___) — checked before lists so `---` is not
    // read as a `-` bullet (the list rule needs whitespace after the marker).
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); blocks.push({ type: 'hr' }); i += 1; continue; }
    const img = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (img) { flushPara(); blocks.push({ type: 'image', alt: img[1], src: img[2] }); i += 1; continue; }
    // GFM table: a pipe-bearing header row immediately followed by a separator
    // row of dashes. Consume contiguous pipe rows as the body. Checked before
    // the quote/list/para fallbacks so the pipes don't render literally.
    if (line.includes('|') && i + 1 < lines.length && mdTableSep(lines[i + 1])) {
      flushPara();
      const header = mdSplitRow(line);
      const aligns = mdSplitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'); const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        rows.push(mdSplitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', header, aligns, rows });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      // GitHub callout: a leading `[!TIP]` / `[!NOTE]` / `[!WARNING]` … marker
      // promotes the blockquote to a labeled callout box; the marker line is
      // consumed and the type carried on the block.
      const co = /^\[!(\w+)\]\s*$/.exec(body[0] || '');
      if (co) blocks.push({ type: 'quote', callout: co[1].toUpperCase(), text: body.slice(1).join('\n') });
      else blocks.push({ type: 'quote', text: body.join('\n') });
      continue;
    }
    if (listRe.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length) {
        const m = listRe.exec(lines[i]);
        if (m) {
          const indent = m[1].replace(/\t/g, '  ').length;
          items.push({ indent, ordered: /\d/.test(m[2]), marker: m[2], text: m[3] });
          i += 1;
          continue;
        }
        // A non-blank indented line that is not itself a marker is a wrapped
        // continuation of the current item; a blank line or a flush-left line
        // ends the list.
        if (items.length && /^\s+\S/.test(lines[i])) {
          items[items.length - 1].text += '\n' + lines[i].trim();
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: 'list', items });
      continue;
    }
    para.push(line);
    i += 1;
  }
  flushPara();
  return blocks;
}

const MD_HEADING_SIZE = { 1: 23, 2: 18, 3: 15, 4: 13, 5: 12, 6: 12 };

// GitHub callout types → display label + accent (theme-aware tag foregrounds).
const MD_CALLOUT = {
  NOTE: { label: 'Note', color: WF.tagBlueFg },
  TIP: { label: 'Tip', color: WF.tagGreenFg },
  IMPORTANT: { label: 'Important', color: WF.tagPurpleFg },
  WARNING: { label: 'Warning', color: WF.tagAmberFg },
  CAUTION: { label: 'Caution', color: WF.tagRedFg },
};

// GitHub-style heading slug: lowercase, drop everything but word chars / spaces /
// hyphens (so backticks and punctuation in a heading don't leak into the anchor),
// then spaces → hyphens. "Settings reference" → "settings-reference". Used as the
// heading element id so a `#…` Markdown link can scroll to it.
const mdSlug = (s) =>
  String(s).toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

// Inline `[label](href)` link. With an `onLink` host handler, navigation is fully
// delegated (default suppressed) — the help page uses it to open AGENTS.md in-app,
// smooth-scroll `#` anchors, and send external URLs to a new tab. Without one,
// external hrefs open in a new tab and other hrefs fall back to native `<a>`.
function MdLink({ href, onLink, children }) {
  const external = /^(https?:|mailto:)/i.test(href) || href.startsWith('//');
  const handleClick = (e) => {
    if (onLink) { e.preventDefault(); onLink(href, e); }
  };
  return (
    <a
      href={href}
      onClick={handleClick}
      target={external && !onLink ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      style={{ color: WF.tagBlueFg, textDecoration: 'underline', textUnderlineOffset: '0.15em', cursor: 'pointer' }}
    >
      {children}
    </a>
  );
}

// `scale` multiplies every font size this block controls (default 1 — unchanged
// for the trace-doc viewer); the readme/help page passes a value > 1 for a
// roomier read. Inline `<code>` is sized in `em`, so it tracks the scaled parent
// automatically. `imgFill` makes images take the full content width (so the text
// column and the figure render at exactly the same width) instead of merely
// capping at it — used by the readme page, where the GIFs should line up with
// the prose regardless of their intrinsic pixel size. `onLink` is threaded into
// every inline render so `[…](…)` links are clickable (see renderInline opts).
function MdBlock({ block, resolveImg, scale = 1, imgFill = false, onLink }) {
  const sz = (n) => Math.round(n * scale);
  // Every inline render in this block opts into link parsing and shares the host
  // link handler; emphasis/code behaviour is otherwise unchanged. (Named `inl`,
  // not `ri`, to avoid shadowing the table-row index `ri` used below.)
  const inl = (t) => renderInline(t, 'md', { links: true, onLink });
  if (block.type === 'heading') {
    const size = MD_HEADING_SIZE[block.level] || 13;
    return (
      <L
        id={mdSlug(block.text)}
        size={sz(size)}
        weight={700}
        color={block.level >= 4 ? WF.ink2 : WF.ink}
        style={{
          display: 'block',
          marginTop: block.level <= 2 ? 10 : 4,
          paddingBottom: block.level === 1 ? 6 : 0,
          borderBottom: block.level === 1 ? inkBorder(1.5) : undefined,
        }}
      >
        {inl(block.text)}
      </L>
    );
  }
  if (block.type === 'hr') return <Rule />;
  if (block.type === 'code') {
    return (
      <pre
        style={{
          margin: 0,
          padding: 10,
          overflowX: 'auto',
          background: WF.paperAlt,
          border: inkBorder(1.2),
          fontFamily: WF.monoFont,
          fontSize: sz(12),
          lineHeight: 1.5,
          color: WF.ink,
          whiteSpace: 'pre',
        }}
      >
        {block.lines.join('\n')}
      </pre>
    );
  }
  if (block.type === 'image') {
    const src = resolveImg ? resolveImg(block.src) : block.src;
    // Animated GIFs play and loop on their own in an <img>; nothing extra is
    // needed for autoplay. The alt text doubles as a caption when present.
    return (
      <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
        <img
          src={src}
          alt={block.alt}
          loading="lazy"
          style={{ width: imgFill ? '100%' : undefined, maxWidth: '100%', border: inkBorder(1.2) }}
        />
        {block.alt && (
          <figcaption><L size={sz(11)} mono color={WF.ink3}>{block.alt}</L></figcaption>
        )}
      </figure>
    );
  }
  if (block.type === 'table') {
    const cellBase = { border: inkBorder(1.2), padding: '6px 10px', verticalAlign: 'top' };
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: WF.bodyFont, fontSize: sz(13) }}>
          <thead>
            <tr>
              {block.header.map((h, j) => (
                <th key={j} style={{ ...cellBase, textAlign: block.aligns[j] || 'left', background: WF.paperAlt, color: WF.ink, fontWeight: 700 }}>
                  {inl(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((r, ri) => (
              <tr key={ri}>
                {block.header.map((_, j) => (
                  <td key={j} style={{ ...cellBase, textAlign: block.aligns[j] || 'left', color: WF.ink2 }}>
                    {inl(r[j] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.type === 'quote') {
    if (block.callout) {
      const c = MD_CALLOUT[block.callout] || { label: block.callout, color: WF.ink2 };
      return (
        <div style={{ border: inkBorder(1.2), borderLeft: `4px solid ${c.color}`, background: WF.paperAlt, padding: '8px 12px' }}>
          <L mono size={sz(10)} weight={700} color={c.color} style={{ display: 'block', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
            {c.label}
          </L>
          <L size={sz(13)} color={WF.ink2} style={{ display: 'block', whiteSpace: 'normal', lineHeight: 1.5 }}>
            {inl(block.text)}
          </L>
        </div>
      );
    }
    return (
      <div style={{ borderLeft: `4px solid ${WF.rule}`, paddingLeft: 12 }}>
        <L size={sz(13)} color={WF.ink2} style={{ display: 'block', whiteSpace: 'normal', lineHeight: 1.5 }}>
          {inl(block.text)}
        </L>
      </div>
    );
  }
  if (block.type === 'list') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {block.items.map((it, i) => (
          <div
            key={i}
            style={{ display: 'flex', gap: 8, paddingLeft: 2 + Math.floor((it.indent || 0) / 2) * 16 }}
          >
            <L mono size={sz(13)} color={WF.ink3} style={{ flexShrink: 0, minWidth: it.ordered ? 18 : 8 }}>
              {it.ordered ? it.marker : '•'}
            </L>
            <L size={sz(13)} style={{ whiteSpace: 'normal', lineHeight: 1.5 }}>{inl(it.text)}</L>
          </div>
        ))}
      </div>
    );
  }
  return (
    // Paragraph: white-space:normal so a single source newline is a CommonMark
    // soft break (collapses to a space) and only a blank line — which the parser
    // already turns into a separate block — starts a new paragraph.
    <L size={sz(13)} style={{ display: 'block', whiteSpace: 'normal', lineHeight: 1.5 }}>
      {inl(block.text)}
    </L>
  );
}

export function Markdown({ text, resolveImg, style = {}, scale = 1, imgFill = false, onLink }) {
  const blocks = React.useMemo(() => parseMdBlocks(text || ''), [text]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, ...style }}>
      {blocks.map((b, i) => <MdBlock key={i} block={b} resolveImg={resolveImg} scale={scale} imgFill={imgFill} onLink={onLink} />)}
    </div>
  );
}
