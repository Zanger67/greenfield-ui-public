// Shared wireframe primitives — Balsamiq-ish monochrome boxes with a single
// red-heat accent for suspicion. Ported from the design handoff bundle:
// ink strokes, handwritten headings, mono for code/labels, no SVG icons —
// [bracket] mono tags as placeholders instead.
import React from 'react';

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

export function L({ children, size = 13, mono = false, color, style = {}, weight = 400, onClick, title }) {
  // onClick / title are forwarded: several call sites style an <L> as a link
  // (cursor:pointer, dotted underline) and pass onClick to navigate — e.g. the
  // "open →" commit link and the auditor-comment labels on the areas screen.
  // Without forwarding, those handlers were silently dropped and the links did
  // nothing. title drives the hover tooltips a few <L>s ask for.
  return (
    <span
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

export function renderInline(text, keyPrefix = 'md') {
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
        <strong key={`${keyPrefix}-${key++}`}><em>{renderInline(m[1], `${keyPrefix}-${key}bi`)}</em></strong>
      );
    } else if ((m = /^\*\*(?!\s)([\s\S]+?)\*\*/.exec(rest))) {
      flush();
      nodes.push(<strong key={`${keyPrefix}-${key++}`}>{renderInline(m[1], `${keyPrefix}-${key}b`)}</strong>);
    } else if ((m = /^\*(?!\s)([^*\n]+?)\*/.exec(rest))) {
      flush();
      nodes.push(<em key={`${keyPrefix}-${key++}`}>{renderInline(m[1], `${keyPrefix}-${key}i`)}</em>);
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

// Compose a compact, paste-ready reference line for handing one target off to a
// coding agent: what it is, the id that joins it onto the metadata sidecars, and
// its associated commit hashes. Terse on purpose so it drops cleanly into a
// Claude Code prompt alongside AGENTS.md.
export function refStatement({ kind, label, idField, id, shas = [] }) {
  const list = (shas || []).filter(Boolean);
  const idPart = id ? ` — ${idField}: ${id}` : '';
  const shaPart = list.length ? ` · commit hash${list.length === 1 ? '' : 'es'}: ${list.join(', ')}` : '';
  return `${kind} "${label}"${idPart}${shaPart}. See the UI's AGENTS.md to navigate the metadata sidecars and codebase/ git history.`;
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
// on static titles (commit / area / thread); for an editable title field use
// CopyChip beside it instead.
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

// A Chip that copies `text` on click, flashing "copied ✓". For an inline "copy
// references" affordance next to a title that is itself not clickable (e.g. the
// editable group-name field).
export function CopyChip({ text, label = '⧉ copy refs', title = 'copy references', style = {} }) {
  const { copied, copy } = useCopy(text);
  return (
    <Chip
      onClick={copy}
      title={title}
      color={copied ? WF.add : WF.ink2}
      bg={WF.paperAlt}
      style={{ cursor: 'pointer', ...style }}
    >{copied ? 'copied ✓' : label}</Chip>
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
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      blocks.push({ type: 'quote', text: body.join('\n') });
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

function MdBlock({ block, resolveImg }) {
  if (block.type === 'heading') {
    const size = MD_HEADING_SIZE[block.level] || 13;
    return (
      <L
        size={size}
        weight={700}
        color={block.level >= 4 ? WF.ink2 : WF.ink}
        style={{
          display: 'block',
          marginTop: block.level <= 2 ? 10 : 4,
          paddingBottom: block.level === 1 ? 6 : 0,
          borderBottom: block.level === 1 ? inkBorder(1.5) : undefined,
        }}
      >
        {renderInline(block.text)}
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
          fontSize: 12,
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
    return <img src={src} alt={block.alt} style={{ maxWidth: '100%', border: inkBorder(1.2) }} />;
  }
  if (block.type === 'quote') {
    return (
      <div style={{ borderLeft: `4px solid ${WF.rule}`, paddingLeft: 12 }}>
        <L size={13} color={WF.ink2} style={{ display: 'block', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
          {renderInline(block.text)}
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
            <L mono size={13} color={WF.ink3} style={{ flexShrink: 0, minWidth: it.ordered ? 18 : 8 }}>
              {it.ordered ? it.marker : '•'}
            </L>
            <L size={13} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{renderInline(it.text)}</L>
          </div>
        ))}
      </div>
    );
  }
  return (
    <L size={13} style={{ display: 'block', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
      {renderInline(block.text)}
    </L>
  );
}

export function Markdown({ text, resolveImg, style = {} }) {
  const blocks = React.useMemo(() => parseMdBlocks(text || ''), [text]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, ...style }}>
      {blocks.map((b, i) => <MdBlock key={i} block={b} resolveImg={resolveImg} />)}
    </div>
  );
}
