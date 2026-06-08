// Final results — the trace's deliverable artifacts and the docs that frame
// how the experiment was run, presented as a reading surface alongside the
// commit-level navigation. Every processed trace ships a standardized set of
// files (see CLAUDE.md / the trace README): under `main_results/` a
// `final_report.md` plus the result figures, and at the root the blue-team
// audit report and the experiment description / guide. This screen surfaces
// exactly those — README.md is excluded (it documents the package layout, not
// the experiment).
//
// These are static files, not commit-derived, so the screen fetches them
// directly from the trace's data dir (`/data/<input>/…`) rather than going
// through the data store. It tolerates a trace missing any given file: a
// missing doc is greyed out in the nav, and the plots section only lists the
// figures that actually load.
import React from 'react';
import {
  WF,
  inkBorder,
  L,
  Box,
  Chip,
  Rule,
  Markdown,
  LoadingBox,
  AppFrame,
  PaneResizer,
} from './primitives.jsx';
// Width of each plot card's auditor column (flag · tags · notes). The image
// column takes the rest, so the figure stays the dominant, wider half.
const PLOT_AUDIT_COL = 248;
import { useData } from './dataStore.jsx';
import { ScreenTabs } from './App.jsx';
import { TopBarControls, useSettings } from './settings.jsx';
import { AuditorPanel } from './WireSemanticAreas.jsx';
import { ValidatorNotesEditor } from './ValidatorNotes.jsx';
import { FlagTags } from './Tagging.jsx';

const dataUrl = (name, p) => `/data/${name}/${p}`;

// The auditor's flag + notes for a result doc live under a `doc:<id>` overlay
// key — the same namespaced-key scheme the semantic-areas screen uses for
// `area:`/`thread:`. The overview reads these keys back to surface the markups
// (see collectDocMarkups there). Exported so the overview shares one definition.
export const docKey = (id) => `doc:${id}`;

// Each result plot is flaggable / notable on its own, under a `plot:<file>` key
// (distinct from the `doc:plots` gallery-wide key). The overview + group views
// read these back, and the resolver in Tagging.jsx routes them.
export const plotKey = (file) => `plot:${file}`;

// The documents this screen renders, in reading order: result deliverables
// first (front-loaded salience), then the audit verdict, then the process /
// instruction docs. `kind: 'plots'` is the synthetic figure-gallery entry; the
// rest are Markdown files fetched from the path shown. Exported as RESULTS_DOCS
// so the overview can label a `doc:<id>` markup without re-declaring the set.
const DOCS = [
  { id: 'final_report', kind: 'md', label: 'Final report', path: 'main_results/final_report.md', group: 'Results', blurb: "researcher's writeup" },
  { id: 'plots', kind: 'plots', label: 'Result plots', path: 'main_results/', group: 'Results', blurb: 'output figures' },
  { id: 'blue_team', kind: 'md', label: 'Blue-team report', path: 'blue_team_report.md', group: 'Audit', blurb: 'audit verdict' },
  { id: 'experiment', kind: 'md', label: 'Experiment description', path: 'experiment_description.md', group: 'Process & instructions', blurb: 'question + budget' },
  { id: 'guide', kind: 'md', label: 'Guide to experiments', path: 'guide_to_my_experiments.md', group: 'Process & instructions', blurb: 'how experiments run' },
];
export const RESULTS_DOCS = DOCS;

// Figures emitted under main_results/. The comparison_* bars and iteration_*
// line charts are the two plot families plotting.py produces per task/actor.
// Exported so the overview can enumerate per-plot markups without re-declaring.
export const PLOT_FILES = [
  'comparison_blog_gender.png',
  'comparison_math_olympiad.png',
  'comparison_math_olympiad_qwen3-14b-local.png',
  'iteration_lines_blog_gender.png',
  'iteration_lines_math_olympiad.png',
  'iteration_lines_math_olympiad_qwen3-14b-local.png',
];

const MD_DOCS = DOCS.filter((d) => d.kind === 'md');

// Fetch a text artifact, returning null for a miss. Vite's dev SPA fallback
// answers a missing static file with index.html at HTTP 200 / text/html, so
// (mirroring the data store's fetchFirstOk) an HTML content-type is treated as
// "not found" rather than rendered as a document body.
async function fetchDoc(url) {
  try {
    const r = await fetch(url);
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || ct.includes('text/html')) return null;
    return await r.text();
  } catch {
    return null;
  }
}

// Client-side existence check for a figure: resolve true once it decodes, false
// on any load error (404, SPA-fallback HTML, decode failure).
function probeImg(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

// Map a doc's relative image reference to a URL under the trace data dir,
// resolved against the directory the doc itself lives in (so a figure named
// in main_results/final_report.md resolves under main_results/). Absolute /
// protocol / data: URLs pass through untouched.
function makeResolveImg(input, docPath) {
  const slash = docPath.lastIndexOf('/');
  const dir = slash >= 0 ? docPath.slice(0, slash) : '';
  return (src) => {
    if (!src) return src;
    if (/^(https?:)?\/\//.test(src) || src.startsWith('/') || src.startsWith('data:')) return src;
    return dataUrl(input, dir ? `${dir}/${src}` : src);
  };
}

// "comparison_math_olympiad_qwen3-14b-local.png" → "comparison math olympiad
// qwen3-14b-local" — a readable caption derived from the filename, so the
// gallery stays trace-agnostic instead of hard-coding per-figure captions.
function humanizePlot(file) {
  return file.replace(/\.png$/i, '').replace(/_/g, ' ');
}

export function WireResults() {
  const { selectedInput, areaFocus, recordFocus, flaggedOverlay = {}, userNotesOverlay = {} } = useData();
  const { settings, setPaneWidth } = useSettings();
  const navWidth = settings.paneWidths.resultsNav;
  const auditorWidth = settings.paneWidths.auditorPanel;

  const [status, setStatus] = React.useState('loading'); // loading | ready
  const [docs, setDocs] = React.useState({});            // id → text (md docs only)
  const [plots, setPlots] = React.useState([]);          // [{ file, url }] that loaded
  const [selId, setSelId] = React.useState('final_report');

  React.useEffect(() => {
    if (!selectedInput) return undefined;
    let cancelled = false;
    setStatus('loading');
    setDocs({});
    setPlots([]);
    const textP = Promise.all(
      MD_DOCS.map((d) => fetchDoc(dataUrl(selectedInput, d.path)).then((t) => [d.id, t])),
    );
    const plotP = Promise.all(
      PLOT_FILES.map((f) => {
        const url = dataUrl(selectedInput, `main_results/${f}`);
        return probeImg(url).then((ok) => (ok ? { file: f, url } : null));
      }),
    );
    Promise.all([textP, plotP]).then(([texts, plotResults]) => {
      if (cancelled) return;
      const map = Object.fromEntries(texts);
      const loadedPlots = plotResults.filter(Boolean);
      setDocs(map);
      setPlots(loadedPlots);
      const has = (d) => (d.kind === 'plots' ? loadedPlots.length > 0 : !!map[d.id]);
      setSelId((cur) => {
        const keep = DOCS.find((d) => d.id === cur && has(d));
        if (keep) return cur;
        const first = DOCS.find(has);
        return first ? first.id : cur;
      });
      setStatus('ready');
    });
    return () => { cancelled = true; };
  }, [selectedInput]);

  // Deep-link target: the overview routes a flagged/annotated doc here as a
  // `doc:<id>` focus token (see openDoc). Select that doc when the token names a
  // known one; the load effect's keep-if-available rule then preserves it.
  React.useEffect(() => {
    if (!areaFocus || !areaFocus.startsWith('doc:')) return;
    const id = areaFocus.slice(4);
    if (DOCS.some((d) => d.id === id)) setSelId(id);
  }, [areaFocus]);

  const isAvailable = React.useCallback(
    (d) => (d.kind === 'plots' ? plots.length > 0 : !!docs[d.id]),
    [docs, plots],
  );

  // Auditor markups per doc, surfaced as a nav badge so a flagged / annotated
  // doc is visible at a glance — and so the propagation to the overview has a
  // mirror here. The plots gallery aggregates across its per-plot keys, since
  // each figure is flagged / noted individually (not the gallery as a whole).
  const markFor = React.useCallback(
    (d) => {
      if (d.kind === 'plots') {
        let flagged = false;
        let noteCount = 0;
        for (const f of PLOT_FILES) {
          if (flaggedOverlay[plotKey(f)]) flagged = true;
          noteCount += (userNotesOverlay[plotKey(f)] || []).length;
        }
        return { flagged, noteCount };
      }
      return {
        flagged: !!flaggedOverlay[docKey(d.id)],
        noteCount: (userNotesOverlay[docKey(d.id)] || []).length,
      };
    },
    [flaggedOverlay, userNotesOverlay],
  );

  const docCount = MD_DOCS.filter((d) => docs[d.id]).length;
  const sel = DOCS.find((d) => d.id === selId);

  return (
    <AppFrame
      topBar={<ScreenTabs />}
      subtitle={`final results · ${docCount} doc${docCount === 1 ? '' : 's'} · ${plots.length} plot${plots.length === 1 ? '' : 's'}`}
      coverage={false}
      rightSlot={<TopBarControls />}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <ResultsNav
          width={navWidth}
          docs={DOCS}
          selId={selId}
          onSelect={(id) => { setSelId(id); recordFocus(`doc:${id}`); }}
          isAvailable={isAvailable}
          markFor={markFor}
          loading={status === 'loading'}
        />
        <PaneResizer
          width={navWidth}
          setWidth={(w) => setPaneWidth('resultsNav', w)}
          min={200}
          max={460}
          dflt={280}
          dir={1}
        />
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {status === 'loading' ? (
            <div style={{ padding: 40 }}>
              <LoadingBox label="loading trace artifacts" height={120} />
            </div>
          ) : !sel || !isAvailable(sel) ? (
            <EmptyResults input={selectedInput} />
          ) : sel.kind === 'plots' ? (
            <PlotsGallery plots={plots} />
          ) : (
            <DocView doc={sel} text={docs[sel.id]} input={selectedInput} />
          )}
        </div>
        {/* Auditor markups attach to whichever doc is open, under a `doc:<id>`
            key — flag + validator notes, same panel the areas screen uses. The
            overview reads these keys back, so a flag/note here shows up there.
            The plots gallery is the exception: each plot card carries its own
            per-plot auditor column, so the gallery-wide panel is suppressed
            there to avoid a second, redundant auditor surface. */}
        {sel && (status === 'ready') && isAvailable(sel) && sel.kind !== 'plots' && (
          <>
            <PaneResizer
              width={auditorWidth}
              setWidth={(w) => setPaneWidth('auditorPanel', w)}
              min={240}
              max={560}
              dflt={320}
              dir={-1}
            />
            <AuditorPanel targetKey={docKey(sel.id)} noun="document" width={auditorWidth} />
          </>
        )}
      </div>
    </AppFrame>
  );
}

function EmptyResults({ input }) {
  return (
    <div style={{ padding: 40, maxWidth: 640 }}>
      <L size={15} weight={700} style={{ display: 'block', marginBottom: 8 }}>No result artifacts found</L>
      <L mono size={12} color={WF.ink3} style={{ display: 'block', lineHeight: 1.6 }}>
        This trace ({input}) doesn&rsquo;t ship the standardized result files —
        main_results/final_report.md, the result plots, blue_team_report.md, or
        the experiment description / guide. They live at the trace root and under
        main_results/; re-export the trace package if they&rsquo;re missing.
      </L>
    </div>
  );
}

// Left nav: documents grouped by stage, each a button that reads like the
// screen-picker tabs (ink fill when active). Unavailable docs render dimmed and
// non-interactive so the standardized set is always legible even when a trace
// is missing one.
function ResultsNav({ width, docs, selId, onSelect, isAvailable, markFor, loading }) {
  const groups = [];
  for (const d of docs) {
    let g = groups.find((x) => x.name === d.group);
    if (!g) { g = { name: d.group, items: [] }; groups.push(g); }
    g.items.push(d);
  }
  return (
    <div
      style={{
        width,
        flexShrink: 0,
        borderRight: inkBorder(),
        overflow: 'auto',
        padding: '14px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        boxSizing: 'border-box',
      }}
    >
      <L mono size={11} color={WF.ink3}>trace artifacts</L>
      {groups.map((g) => (
        <div key={g.name} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <L size={11} weight={700} color={WF.ink3} style={{ letterSpacing: 0.4, textTransform: 'uppercase' }}>
            {g.name}
          </L>
          {g.items.map((d) => {
            const available = isAvailable(d);
            const active = d.id === selId;
            const mark = markFor ? markFor(d) : { flagged: false, noteCount: 0 };
            return (
              <button
                key={d.id}
                type="button"
                disabled={!available && !loading}
                onClick={() => available && onSelect(d.id)}
                style={{
                  textAlign: 'left',
                  border: inkBorder(1.2),
                  background: active ? WF.ink : WF.paper,
                  color: active ? WF.paper : WF.ink,
                  boxShadow: active ? `2px 2px 0 ${WF.shadow}` : undefined,
                  opacity: available || loading ? 1 : 0.4,
                  cursor: available ? 'pointer' : 'default',
                  padding: '7px 9px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  fontFamily: WF.bodyFont,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <L size={13} weight={600} color={active ? WF.paper : WF.ink}>{d.label}</L>
                  {mark.flagged && (
                    <L size={11} color={active ? WF.paper : WF.heat4} title="you flagged this document">⚑</L>
                  )}
                  {mark.noteCount > 0 && (
                    <L mono size={9} color={active ? WF.paper : WF.ink3} title={`${mark.noteCount} validator note${mark.noteCount === 1 ? '' : 's'}`}>
                      ✎{mark.noteCount}
                    </L>
                  )}
                  {!available && !loading && (
                    <L mono size={9} color={active ? WF.paper : WF.ink3}>· missing</L>
                  )}
                </span>
                <L mono size={10} color={active ? WF.paper : WF.ink3}>{d.blurb}</L>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function DocView({ doc, text, input }) {
  const resolveImg = React.useMemo(() => makeResolveImg(input, doc.path), [input, doc.path]);
  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <L size={12} mono color={WF.ink3}>{doc.path}</L>
        </div>
        <Markdown text={text} resolveImg={resolveImg} />
      </div>
    </div>
  );
}

// The figure gallery. Each plot is its own bordered card laid out as two
// columns — the figure on the (wider) left, the auditor's flag + tags + notes
// on the right — so a plot and the markups that belong to it read as one self
// contained unit, clearly separated from the next plot. The per-plot controls
// are keyed by `plot:<file>`, so plots are audited one at a time.
function PlotsGallery({ plots }) {
  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div>
          <L size={18} weight={700} style={{ display: 'block' }}>Result plots</L>
          <L size={12} color={WF.ink2} style={{ display: 'block', marginTop: 2 }}>
            {plots.length} figure{plots.length === 1 ? '' : 's'} from main_results/ · flag or note each one
          </L>
          <Rule style={{ marginTop: 8 }} />
        </div>
        {plots.map((p) => <PlotCard key={p.file} plot={p} />)}
      </div>
    </div>
  );
}

// One plot as a self-contained, bordered card split into two columns: the
// figure (the wider, dominant left column) and the auditor's controls (right
// column) — a flag toggle (orange when set), the group tag editor, and the
// validator-notes editor, all always visible so a plot's markups sit right next
// to it. Everything is keyed by `plot:<file>` so it round-trips through the same
// overlays / overview / export as every other markup. Flagging a plot here
// shows up on the overview just like a flagged commit or document.
function PlotCard({ plot }) {
  const { flaggedOverlay = {}, userNotesOverlay = {}, toggleFlag } = useData();
  const key = plotKey(plot.file);
  const flagged = !!flaggedOverlay[key];
  const notes = userNotesOverlay[key] || [];
  return (
    <Box style={{ padding: 0, display: 'flex', alignItems: 'stretch', minWidth: 0 }}>
      {/* Left column: the figure (kept wider via flex-grow against the fixed
          auditor column). The image opens full-size in a new tab. */}
      <figure style={{ margin: 0, flex: '1 1 0', minWidth: 0, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <a href={plot.url} target="_blank" rel="noreferrer" title="open full size">
          <img
            src={plot.url}
            alt={humanizePlot(plot.file)}
            style={{ display: 'block', width: '100%', height: 'auto', background: WF.paper, border: inkBorder() }}
          />
        </a>
        <figcaption style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <L size={13} weight={600}>{humanizePlot(plot.file)}</L>
          <Chip>{plot.file}</Chip>
        </figcaption>
      </figure>
      {/* Right column: auditor flag + tags + notes for this plot, divided off
          from the figure so the markups read as belonging to it. */}
      <div
        style={{
          flex: `0 0 ${PLOT_AUDIT_COL}px`,
          minWidth: 0,
          borderLeft: inkBorder(),
          background: WF.paperAlt,
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <L size={11} weight={700} color={WF.ink3} style={{ letterSpacing: 0.4, textTransform: 'uppercase' }}>auditor</L>
          <div style={{ flex: 1 }} />
          <Chip
            onClick={() => toggleFlag(key)}
            style={{ cursor: 'pointer', background: flagged ? WF.userflag : 'transparent', color: flagged ? WF.onAccent : WF.ink, borderColor: WF.userflag, fontWeight: 700 }}
            title={flagged ? 'remove your flag on this plot' : 'flag this plot for review'}
          >{flagged ? '⚑ flagged' : '⚐ flag plot'}</Chip>
        </div>
        <FlagTags targetKey={key} flagged={flagged} />
        <div>
          <L size={11} weight={700} color={WF.ink3} style={{ display: 'block', marginBottom: 8 }}>validator notes (you)</L>
          <ValidatorNotesEditor chunkId={key} notes={notes} placeholder="add a note on this plot …" />
        </div>
      </div>
    </Box>
  );
}
