// Final results — the trace's deliverable artifacts and the docs that frame
// how the experiment was run, presented as a reading surface alongside the
// commit-level navigation. Every processed trace ships a standardized set of
// files (see CLAUDE.md / the trace README): under `main_results/` a
// `final_report.md` plus the result figures, and at the root the blue-team
// audit report and the experiment description / guide. Beyond that standardized
// set the screen also surfaces whatever a trace ships under
// `supplemental_materials/` (any files — PDFs, images, markdown), and the
// package-level "other docs" (CLAUDE.md / AGENTS.md / README.md) when present.
//
// These are static files, not commit-derived, so the screen fetches them
// directly from the trace's data dir (`/data/<input>/…`) rather than going
// through the data store — except the supplemental file *listing*, whose
// open-ended filenames ride along in /data/index.json (see vite.config's
// listSupplemental) and reach the screen via the data store's currentTrace.
//
// Missing-file handling differs by doc, by design (see each doc's `onMissing`):
//   * the standardized result/process docs (final report, plots, experiment
//     description, guide) always show in the nav — greyed and badged "(none)"
//     when the trace doesn't ship them, so the expected set stays legible;
//   * everything else — the blue-team report, the supplemental files, and the
//     other docs — is omitted entirely when absent (no empty section header).
// The plots section only lists the figures that actually load either way.
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
import { TopBarControls, useSettings, useAnonymize } from './settings.jsx';
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

// Group labels used by the nav, in render order. Supplemental sits directly
// above "other docs", per the screen's reading order.
const GROUP_SUPP = 'Supplemental materials';
const GROUP_OTHER = 'Other docs';

// How the nav treats a doc the trace doesn't ship:
//   'none' — keep it in the nav, greyed + badged "(none)" (the standardized set,
//            so the expected artifacts stay legible even when one is absent);
//   'hide' — drop it entirely (no row, and no empty section header).
// The standardized result/process docs are 'none'; the blue-team report, the
// supplemental files, and the other docs are 'hide'.

// The standardized documents, in reading order: result deliverables first
// (front-loaded salience), then the audit verdict, then the process / instruction
// docs. `kind: 'plots'` is the synthetic figure-gallery entry; the rest are
// Markdown files fetched from the path shown.
const STANDARD_DOCS = [
  { id: 'final_report', kind: 'md', label: 'Final report', path: 'main_results/final_report.md', group: 'Results', blurb: "researcher's writeup", onMissing: 'none' },
  { id: 'plots', kind: 'plots', label: 'Result plots', path: 'main_results/', group: 'Results', blurb: 'output figures', onMissing: 'none' },
  { id: 'blue_team', kind: 'md', label: 'Blue-team report', path: 'blue_team_report.md', group: 'Audit', blurb: 'audit verdict', onMissing: 'hide' },
  { id: 'experiment', kind: 'md', label: 'Experiment description', path: 'experiment_description.md', group: 'Process & instructions', blurb: 'question + budget', onMissing: 'none' },
  { id: 'guide', kind: 'md', label: 'Guide to experiments', path: 'guide_to_my_experiments.md', group: 'Process & instructions', blurb: 'how experiments run', onMissing: 'none' },
];

// Package-level docs that frame the trace but aren't experiment output. Shown
// only when present (README.md used to be excluded outright; it now lives here
// alongside the agent-instruction docs). All fetched from the trace root.
const OTHER_DOCS = [
  { id: 'doc_claude', kind: 'md', label: 'CLAUDE.md', path: 'CLAUDE.md', group: GROUP_OTHER, blurb: 'agent instructions', onMissing: 'hide' },
  { id: 'doc_agents', kind: 'md', label: 'AGENTS.md', path: 'AGENTS.md', group: GROUP_OTHER, blurb: 'agent handoff schema', onMissing: 'hide' },
  { id: 'doc_readme', kind: 'md', label: 'README.md', path: 'README.md', group: GROUP_OTHER, blurb: 'package layout', onMissing: 'hide' },
];

// The static, known docs — exported as RESULTS_DOCS so the overview / export can
// label a `doc:<id>` markup without re-declaring the set. Supplemental files are
// dynamic (per-trace) so they aren't here; collectDocMarkups picks those up off
// the overlay keys directly.
export const RESULTS_DOCS = [...STANDARD_DOCS, ...OTHER_DOCS];

// Image extensions the gallery / doc viewer renders inline as <img>.
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'];
// Text-ish extensions rendered as Markdown (.md) or preformatted text.
const TEXT_EXTS = ['txt', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml'];

// The doc `kind` for a supplemental file, by extension: markdown → 'md' (rendered
// like the other markdown docs), images → 'image', PDFs → 'pdf' (the embedded
// reader), other text → 'text' (preformatted), anything else → 'file' (an
// open/download link). Drives both the viewer switch and the fetch decision
// (only 'md'/'text' need their body pulled in).
function kindForFile(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'pdf') return 'pdf';
  if (IMG_EXTS.includes(ext)) return 'image';
  if (TEXT_EXTS.includes(ext)) return 'text';
  return 'file';
}

// A short nav blurb for a supplemental file — its type, then the extension.
function suppBlurb(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const kind = kindForFile(name);
  const noun = kind === 'md' ? 'markdown' : kind === 'image' ? 'image' : kind === 'pdf' ? 'PDF' : kind === 'text' ? 'text' : 'file';
  return ext ? `${noun} · .${ext}` : noun;
}

// The id under which a supplemental file's markups + selection are keyed. Its
// relative path keeps it unique within the trace; the `supp:` prefix is what
// collectDocMarkups keys off to resolve a path back for export.
const suppId = (rel) => `supp:${rel}`;

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

// Docs whose body the screen fetches up front (so availability is "did the text
// load" and the viewer has it ready): the markdown + preformatted-text kinds.
// Image / PDF / opaque-file docs aren't fetched — they render from their URL, and
// for supplemental files their presence is already known from the listing.
const needsText = (d) => d.kind === 'md' || d.kind === 'text';

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
  const { selectedInput, currentTrace, areaFocus, recordFocus, flaggedOverlay = {}, userNotesOverlay = {} } = useData();
  const { settings, setPaneWidth } = useSettings();
  const navWidth = settings.paneWidths.resultsNav;
  const auditorWidth = settings.paneWidths.auditorPanel;

  const [status, setStatus] = React.useState('loading'); // loading | ready
  const [docs, setDocs] = React.useState({});            // id → text (md / text docs)
  const [plots, setPlots] = React.useState([]);          // [{ file, url }] that loaded
  const [selId, setSelId] = React.useState('final_report');
  const docScrollRef = React.useRef(null);

  // Supplemental files shipped by the selected trace, from the manifest (see
  // listSupplemental in vite.config). A stable string key drives the load effect
  // + the memo so a same-contents array doesn't churn either.
  const suppList = React.useMemo(
    () => (Array.isArray(currentTrace?.supplemental) ? currentTrace.supplemental : []),
    [currentTrace],
  );
  const suppKey = suppList.join('\n');

  // One nav entry per supplemental file, kind derived from its extension. These
  // sit in their own section, directly above the "other docs" section.
  const suppDocs = React.useMemo(
    () => suppList.map((rel) => ({
      id: suppId(rel),
      kind: kindForFile(rel),
      label: rel,
      path: `supplemental_materials/${rel}`,
      group: GROUP_SUPP,
      blurb: suppBlurb(rel),
      onMissing: 'hide',
    })),
    [suppKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The full nav set in render order: standardized docs, then supplemental files,
  // then the package-level other docs.
  const docList = React.useMemo(
    () => [...STANDARD_DOCS, ...suppDocs, ...OTHER_DOCS],
    [suppDocs],
  );

  React.useEffect(() => {
    if (!selectedInput) return undefined;
    let cancelled = false;
    setStatus('loading');
    setDocs({});
    setPlots([]);
    // Fetch the body of every text-bearing doc (markdown + preformatted); image /
    // PDF / opaque-file docs render from their URL, so they're not fetched here.
    const textP = Promise.all(
      docList.filter(needsText).map((d) => fetchDoc(dataUrl(selectedInput, d.path)).then((t) => [d.id, t])),
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
      // Availability for the keep/first-pick: text docs by loaded body, plots by
      // count, and image/PDF/file docs (supplemental) by their presence in the
      // listing — they're in docList only because the manifest named them.
      const has = (d) => (d.kind === 'plots' ? loadedPlots.length > 0 : needsText(d) ? !!map[d.id] : true);
      setSelId((cur) => {
        const keep = docList.find((d) => d.id === cur && has(d));
        if (keep) return cur;
        const first = docList.find(has);
        return first ? first.id : cur;
      });
      setStatus('ready');
    });
    return () => { cancelled = true; };
  }, [selectedInput, suppKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deep-link target: the overview routes a flagged/annotated doc here as a
  // `doc:<id>` focus token (see openDoc). Select that doc when the token names a
  // known one; the load effect's keep-if-available rule then preserves it.
  React.useEffect(() => {
    if (!areaFocus || !areaFocus.startsWith('doc:')) return;
    const id = areaFocus.slice(4);
    if (docList.some((d) => d.id === id)) setSelId(id);
  }, [areaFocus, docList]);

  // Switching documents should land at the top, not inherit the prior doc's
  // scroll depth — the scroll container is reused across selections, so reset
  // it by hand whenever the open doc changes.
  React.useEffect(() => {
    if (docScrollRef.current) docScrollRef.current.scrollTop = 0;
  }, [selId]);

  const isAvailable = React.useCallback(
    (d) => (d.kind === 'plots' ? plots.length > 0 : needsText(d) ? !!docs[d.id] : true),
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

  // Subtitle count: every available non-plots doc (standardized + supplemental +
  // other), so the supplemental/other files register in the header tally too.
  const docCount = docList.filter((d) => d.kind !== 'plots' && isAvailable(d)).length;
  const sel = docList.find((d) => d.id === selId);

  return (
    <AppFrame
      topBar={<ScreenTabs />}
      subtitle={`docs & final results · ${docCount} doc${docCount === 1 ? '' : 's'} · ${plots.length} plot${plots.length === 1 ? '' : 's'}`}
      coverage={false}
      rightSlot={<TopBarControls />}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <ResultsNav
          width={navWidth}
          docs={docList}
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
        <div ref={docScrollRef} style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
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
// screen-picker tabs (ink fill when active). Missing docs render by their
// `onMissing` policy: 'none' docs (the standardized set) stay, dimmed + badged
// "(none)" so the expected artifacts are always legible; 'hide' docs (blue-team
// report, supplemental files, other docs) drop out entirely. A group whose items
// all dropped out renders no header. While still loading, 'hide' docs whose
// availability isn't known yet are withheld rather than shown-then-vanished.
function ResultsNav({ width, docs, selId, onSelect, isAvailable, markFor, loading }) {
  // Decide each doc's nav fate once: keep + interactive, keep + greyed "(none)",
  // or omit. 'hide' docs only appear once confirmed available (so they pop in
  // rather than flicker out when the load resolves them absent).
  const groups = [];
  for (const d of docs) {
    const available = isAvailable(d);
    if (!available && d.onMissing === 'hide') continue;
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
                    <L mono size={9} color={active ? WF.paper : WF.ink3}>· (none)</L>
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

// The reading surface for a single doc. Markdown renders as parsed Markdown;
// `text` files render preformatted; images render inline; PDFs embed in the
// reader; anything else (opaque file) offers an open/download link. The path
// caption sits above all of them so the auditor always sees what they're looking
// at. Only the standardized + other docs reach the md branch; the supplemental
// kinds (image/pdf/text/file) come straight from the listing.
function DocView({ doc, text, input }) {
  const anon = useAnonymize();
  const resolveImg = React.useMemo(() => makeResolveImg(input, doc.path), [input, doc.path]);
  const url = dataUrl(input, doc.path);
  // scrambleText (via anon) keeps every markdown sigil (#, **, `, -, |) intact, so
  // the whole document can be scrambled before parsing and still renders with its
  // headings / lists / code fences / tables — just with unreadable words.
  let body;
  if (doc.kind === 'image') {
    body = (
      <a href={url} target="_blank" rel="noreferrer" title="open full size">
        <img
          src={url}
          alt={anon(doc.label)}
          style={{ display: 'block', maxWidth: '100%', height: 'auto', background: WF.paper, border: inkBorder() }}
        />
      </a>
    );
  } else if (doc.kind === 'pdf') {
    // The embedded PDF reader. <object> renders the browser's native viewer; the
    // child link is its fallback when inline PDF rendering is unavailable. The
    // PDF bytes aren't anonymized (they're opaque to scrambleText) — supplemental
    // material, not trace narration.
    body = (
      <>
        <object data={url} type="application/pdf" style={{ display: 'block', width: '100%', height: '80vh', border: inkBorder() }}>
          <L size={12} color={WF.ink3} style={{ display: 'block', padding: 12 }}>
            This browser can&rsquo;t show the PDF inline.{' '}
            <a href={url} target="_blank" rel="noreferrer" style={{ color: WF.ink }}>Open {doc.label} in a new tab.</a>
          </L>
        </object>
        <L size={11} mono color={WF.ink3} style={{ display: 'block', marginTop: 8 }}>
          <a href={url} target="_blank" rel="noreferrer" style={{ color: WF.ink3 }}>open full size ↗</a>
        </L>
      </>
    );
  } else if (doc.kind === 'text') {
    body = (
      <pre
        style={{
          margin: 0, padding: 14, background: WF.paperAlt, border: inkBorder(),
          fontFamily: WF.monoFont, fontSize: 12, lineHeight: 1.6,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowX: 'auto',
        }}
      >{anon(text)}</pre>
    );
  } else if (doc.kind === 'md') {
    body = <Markdown text={anon(text)} resolveImg={resolveImg} />;
  } else {
    // Opaque file — nothing to render inline, so offer the link.
    body = (
      <L size={13} color={WF.ink2} style={{ display: 'block' }}>
        This file can&rsquo;t be previewed.{' '}
        <a href={url} target="_blank" rel="noreferrer" style={{ color: WF.ink }}>Open {doc.label} ↗</a>
      </L>
    );
  }
  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ maxWidth: doc.kind === 'pdf' ? 1080 : 880, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <L size={12} mono color={WF.ink3}>{anon(doc.path)}</L>
        </div>
        {body}
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
  const anon = useAnonymize();
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
            alt={anon(humanizePlot(plot.file))}
            style={{ display: 'block', width: '100%', height: 'auto', background: WF.paper, border: inkBorder() }}
          />
        </a>
        <figcaption style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <L size={13} weight={600}>{anon(humanizePlot(plot.file))}</L>
          <Chip>{anon(plot.file)}</Chip>
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
