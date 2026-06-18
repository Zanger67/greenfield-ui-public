// Help / README screen. Renders the app's own README.md as rendered Markdown —
// headings, code blocks, GFM tables, GitHub callouts, and the illustration GIFs
// under docs/ — so a fresh auditor can read the mental model before touching a
// trace. It's the first-open default (see the manifest effect in dataStore) and
// is reachable any time from the `?` button in the top bar.
//
// The README text is pulled in at build time via Vite's `?raw` import, and the
// illustration assets via `import.meta.glob` so they resolve to real bundled
// URLs in both `npm run dev` and a static `npm run build`. Nothing is fetched
// from the trace data dir — this is app documentation, not trace-derived, so it
// is never anonymized and renders even while a trace is still loading.
//
// The README links to AGENTS.md (the agent-handoff schema). There's no router and
// no separate page for it, so this screen doubles as the AGENTS.md viewer: the
// Markdown `onLink` handler swaps the rendered doc in place (with a back link),
// which is the only spot AGENTS.md needs to be reachable from.
import React from 'react';
import { AppFrame, L, WF, Markdown, inkBorder } from './primitives.jsx';
import { useData } from './dataStore.jsx';
import { ScreenTabs } from './App.jsx';
import { TopBarControls } from './settings.jsx';
import readmeText from '../README.md?raw';
import agentsText from '../AGENTS.md?raw';

// Every illustration asset under docs/, keyed by URL. The README references them
// by their `docs/readme instructions/<file>` path; we match on basename so the
// reference resolves regardless of the (space-bearing) directory or the hashed
// build URL.
const DOC_ASSETS = import.meta.glob('../docs/**/*.{gif,png,webp,jpg,jpeg,svg}', {
  eager: true,
  query: '?url',
  import: 'default',
});
const ASSET_BY_BASENAME = {};
for (const [path, url] of Object.entries(DOC_ASSETS)) {
  ASSET_BY_BASENAME[path.split('/').pop()] = url;
}

// Map a README image reference to a bundled asset URL. Absolute / protocol /
// data: URLs pass through; everything else resolves by basename (so the `%20`
// the README uses for the space in "readme instructions" doesn't matter).
function resolveReadmeImg(src) {
  if (!src) return src;
  if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) return src;
  const base = decodeURIComponent(src.split('/').pop());
  return ASSET_BY_BASENAME[base] || src;
}

// One column width for the whole page: the prose wraps here AND the GIFs fill it
// (imgFill below), so the text block and the screencaps render at exactly the
// same width. Kept at/under the GIFs' intrinsic width (1200px) so filling
// downscales them — sharp, never upscaled-blurry.
const README_COL = 900;

const linkStyle = {
  color: WF.tagBlueFg,
  textDecoration: 'underline',
  textUnderlineOffset: '0.15em',
  cursor: 'pointer',
};

export function WireReadme() {
  const { goScreen } = useData();
  // 'readme' | 'agents' — which doc is showing. AGENTS.md opens in place rather
  // than as a separate screen (there's no router); the README's link to it is the
  // only entry point.
  const [view, setView] = React.useState('readme');
  const scrollRef = React.useRef(null);

  // Reset scroll to the top whenever the doc swaps, so opening AGENTS.md (or
  // returning) starts at its heading instead of mid-page.
  React.useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [view]);

  // Markdown link handler for the help docs. AGENTS.md (the one in-app target)
  // swaps this screen to the schema doc; `#…` anchors smooth-scroll to the heading
  // with that slug; external URLs open in a new tab; anything else is ignored so
  // there are no dead navigations.
  const onLink = React.useCallback((href) => {
    if (/(^|\/)AGENTS\.md(#.*)?$/i.test(href)) { setView('agents'); return; }
    if (href.startsWith('#')) {
      const el = document.getElementById(href.slice(1));
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (/^(https?:|mailto:)/i.test(href) || href.startsWith('//')) {
      window.open(href, '_blank', 'noopener');
    }
  }, []);

  const text = view === 'agents' ? agentsText : readmeText;

  return (
    <AppFrame topBar={<ScreenTabs />} rightSlot={<TopBarControls />} coverage={false}>
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {/* Persistent close affordance. Pinned to the top of the scroll area
            (position:sticky) so it stays on screen the whole time the doc is
            scrolled, and horizontally anchored just left of the rendered Markdown
            column — it lives in the left gutter, never over the prose. The
            zero-height wrapper overlays the content without nudging it; pointer
            events pass through everywhere except the button. Closing returns to the
            timeline, the same target as the top-bar `?` toggle. */}
        <div style={{ position: 'sticky', top: 0, height: 0, zIndex: 5, pointerEvents: 'none' }}>
          <div style={{ width: README_COL - 48, maxWidth: 'calc(100% - 48px)', margin: '0 auto', position: 'relative' }}>
            <button
              aria-label="close help"
              title="close help — return to the timeline"
              onClick={() => goScreen('dossier')}
              style={{
                pointerEvents: 'auto',
                position: 'absolute',
                // Lined up with the page's H1 ("Redlogs — …"): 32px column
                // padding-top + 10px heading margin-top, nudged to sit on the
                // scaled heading's text line rather than its top edge.
                top: 52,
                right: '100%',
                marginRight: 16,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: 0,
                border: 'none',
                background: 'none',
                fontFamily: WF.monoFont,
                fontSize: 12,
                lineHeight: 1,
                color: WF.ink3,
                opacity: 0.7,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              ↰ esc
            </button>
          </div>
        </div>
        <div style={{ maxWidth: README_COL, margin: '0 auto', padding: '32px 24px', boxSizing: 'border-box' }}>
          {view === 'agents' && (
            <L mono size={13} onClick={() => setView('readme')} style={{ display: 'inline-block', marginBottom: 16, ...linkStyle }}>
              ← back to help
            </L>
          )}
          <Markdown text={text} resolveImg={resolveReadmeImg} onLink={onLink} scale={1.15} imgFill />
        </div>
      </div>
    </AppFrame>
  );
}
