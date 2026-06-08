// Dossier Inbox — commit-driven triage. Left pane: one row per event in
// event_commit_map.jsonl, ordered chronologically. Right pane: a dossier
// for the currently selected commit (rawLine details, pre-flagged
// anomalies, validator notes).
//
// 3-second hold gesture on a row issues a POST /api/checkout to the dev
// middleware so the auditor's editor can follow the trace through the
// reconstruction repo. A plain click just selects the row.
import React from 'react';
import {
  WF,
  inkBorder,
  L,
  Box,
  Tiles,
  Chip,
  Check,
  CopyTitle,
  refStatement,
  AppFrame,
  LoadingBox,
  Dots,
  PaneResizer,
  renderInline,
} from './primitives.jsx';
import { useData } from './dataStore.jsx';
import { ScreenTabs, CheckoutContext } from './App.jsx';
import { TopBarControls, Stamp, Sha, TagFlagsHint, useSettings, PANE_DEFAULTS } from './settings.jsx';
import { ValidatorNotesEditor } from './ValidatorNotes.jsx';
import { TagEditor } from './Tagging.jsx';

const HOLD_MS = 3000;

// Git endpoints resolve their reconstruction repo from the selected input;
// append it as `&name=` (omitted while no input is selected yet).
const nameParam = (n) => (n ? `&name=${encodeURIComponent(n)}` : '');

// Clip a string to `n` chars with a trailing ellipsis — used for the optional
// "description" inbox subline, which draws on the annotation agent's full note.
const clipText = (s, n) => (!s ? '' : s.length <= n ? s : s.slice(0, n - 1) + '…');

const KIND_STYLE = {
  CREATE:  { glyph: '+',  bg: WF.tagGreenBg,  fg: WF.tagGreenFg },
  MODIFY:  { glyph: '~',  bg: WF.tagAmberBg,  fg: WF.tagAmberFg },
  DELETE:  { glyph: '-',  bg: WF.tagRedBg,    fg: WF.heat4 },
  BASH:    { glyph: '$',  bg: WF.tagPurpleBg, fg: WF.tagPurpleFg },
  TOOL:    { glyph: '⚙',  bg: WF.tagBlueBg,   fg: WF.tagBlueFg },
  SESSION: { glyph: '◇',  bg: WF.paperAlt, fg: WF.ink2 },
  SYNC:    { glyph: '↺',  bg: WF.paperAlt, fg: WF.ink2 },
};

const KIND_ORDER = ['CREATE', 'MODIFY', 'DELETE', 'BASH', 'TOOL', 'SESSION', 'SYNC'];

// File-class badge for create/delete (and modify) events: distinguishes
// authored source ('code') from produced artifacts ('data'). Keyed off the
// chunk's `fileClass` derived in dataStore; null ⇒ no badge.
const FILECLASS_STYLE = {
  code: { label: 'code', glyph: '{ }', bg: WF.tagBlueBg,  fg: WF.tagBlueFg,  title: 'source / content file' },
  data: { label: 'data', glyph: '▣',   bg: WF.tagAmberBg, fg: WF.tagAmberFg, title: 'data / results artifact (json, png, …)' },
};

const LEVEL_STYLE = {
  high:   { bg: WF.heat4, fg: WF.onAccent, label: '⚠ HIGH' },
  medium: { bg: WF.heat3, fg: WF.onAccent, label: '⚠ med' },
  low:    { bg: WF.heat2, fg: WF.ink,   label: '⚠ low' },
  mild:   { bg: WF.heat2, fg: WF.ink,   label: '⚠ mild' },
};

// Suspect/flag filter facet, collapsed to four buckets, three of which are the
// auditor's own markup or the system's: the auditor's own flags ('mine'), the
// auditor's own validator notes ('notes'), anything the system flagged —
// narrator suspicion levels or a deterministic pre-flag — folded into one 'ai'
// token, and a 'clean' bucket for commits carrying no marker at all. 'clean' is
// mutually exclusive with the rest; a commit can be any of 'mine'/'notes'/'ai'.
const FLAG_ORDER = ['mine', 'notes', 'ai', 'clean'];
const FLAG_STYLE = {
  mine:  { glyph: '★', label: 'my flags',   bg: WF.tagSlateBg, fg: WF.ink },
  notes: { glyph: '✎', label: 'my notes',   bg: WF.tagBlueBg,  fg: WF.tagBlueFg },
  ai:    { glyph: '⚠', label: 'ai flags',   bg: WF.tagRedBg,   fg: WF.heat4 },
  clean: { glyph: '·', label: 'clean',      bg: WF.paperAlt,   fg: WF.ink3 },
};

// Whether a commit carries an auditor validator note. Notes live on the chunk
// as `userNotes` (the userNotesOverlay merged in at the data source). A note on
// any single commit makes that commit match the 'my notes' facet — and because
// the facet filters per-commit before grouping, a noted member of a group still
// surfaces on its own, the same way a flagged member does.
const hasUserNote = (c) => Array.isArray(c.userNotes) && c.userNotes.length > 0;

// The flag-facet tokens a commit belongs to (a commit can carry several).
function flagTokens(c) {
  const out = [];
  if (c.userFlagged) out.push('mine');
  if (hasUserNote(c)) out.push('notes');
  if (c.flagLevel || c.flag) out.push('ai');
  if (!c.flagLevel && !c.flag && !c.userFlagged && !hasUserNote(c)) out.push('clean');
  return out;
}

// Immutable Set toggle for facet state setters.
const toggleIn = (key) => (prev) => {
  const next = new Set(prev);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

export function WireDossierInbox() {
  const { data, showAiSuspicion, currentId, navigate, recordFocus, selectedInput, areaFocus } = useData();
  // `data` is already AI-suspicion-gated at the source (DataProvider): when the
  // top-bar AI-flags pill is off, every chunk here arrives with flagLevel /
  // suspicions nulled, so the suspect filter facet, heat gutter, row badges and
  // group roll-ups all neutralize with no extra handling. `showAiSuspicion` is
  // read only to drop the coverage pill's suspicion segment.
  const { chunks, coverage, byId } = data;
  const checkout = React.useContext(CheckoutContext);
  const { paneWidths, setPaneWidth } = useSettings();

  // Three independent filter facets, each a Set of selected tokens. An empty
  // set means "all" for that facet. Within a facet the selected tokens OR
  // together; the three facets AND together (mix-and-match conditions).
  const [kindSel, setKindSel] = React.useState(() => new Set());   // change type
  const [flagSel, setFlagSel] = React.useState(() => new Set());   // suspect / flag
  const [classSel, setClassSel] = React.useState(() => new Set()); // file class
  const [fileFilter, setFileFilter] = React.useState('');          // file-name substring

  const toggleKind = React.useCallback((k) => setKindSel(toggleIn(k)), []);
  const toggleFlagTok = React.useCallback((t) => setFlagSel(toggleIn(t)), []);
  const toggleClass = React.useCallback((c) => setClassSel(toggleIn(c)), []);
  const resetFilters = React.useCallback(() => {
    setKindSel(new Set());
    setFlagSel(new Set());
    setClassSel(new Set());
    setFileFilter('');
  }, []);

  const filteredRows = React.useMemo(() => {
    const q = fileFilter.trim().toLowerCase();
    return chunks.filter((c) => {
      if (kindSel.size && !kindSel.has(c.kind)) return false;
      if (classSel.size && !classSel.has(c.fileClass)) return false;
      if (flagSel.size && !flagTokens(c).some((t) => flagSel.has(t))) return false;
      if (q && !(c.file || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [chunks, kindSel, flagSel, classSel, fileFilter]);

  // Deterministic commit groups (from classify's commit_sidecar.jsonl) collapse
  // into one item. Selecting the group shows the cumulative diff; selecting a
  // member opens that individual commit. groupSel is local — it overrides the
  // per-commit dossier without touching the global navigation model.
  const [groupSel, setGroupSel] = React.useState(null);

  // groupId → reconstructed group descriptor, built from the unfiltered chunk
  // stream so deep-link nav (overview → group dossier via a `group:<id>` focus)
  // can resolve the group regardless of which filters are live on the list.
  const groupsById = React.useMemo(() => {
    const map = new Map();
    let i = 0;
    while (i < chunks.length) {
      const r = chunks[i];
      if (r.groupId) {
        let j = i + 1;
        while (j < chunks.length && chunks[j].groupId === r.groupId) j++;
        if (j - i >= 2) {
          const members = chunks.slice(i, j);
          const m0 = members[0];
          const mN = members[members.length - 1];
          map.set(r.groupId, {
            id: r.groupId,
            kind: m0.groupKind,
            root: m0.groupRoot,
            members,
            fromSha: m0.sha,
            toSha: mN.sha,
            tStart: m0.t,
            tEnd: mN.t,
          });
          i = j;
          continue;
        }
      }
      i++;
    }
    return map;
  }, [chunks]);

  // A `group:<id>` focus on the dossier screen (set by openGroup) switches the
  // right pane into the group dossier. Consumed once per focus change — the
  // user can still click an individual member afterward to drop back into the
  // single-commit dossier (selectFromList clears groupSel).
  React.useEffect(() => {
    if (!areaFocus || !areaFocus.startsWith('group:')) return;
    const id = areaFocus.slice('group:'.length);
    const g = groupsById.get(id);
    if (g) setGroupSel(g);
  }, [areaFocus, groupsById]);

  // Scroll plumbing for the left list. `listRef` is the scroll container,
  // `currentRowRef` is attached to whichever row is the active commit, and
  // `scrollModeRef` records how the next currentId change should reposition
  // it: 'center' for navigation that arrives from elsewhere (bottom heatmap,
  // scrubber, file timeline, the sync arrow) vs 'nearest' for a plain click on
  // a row already in the list (don't yank a visible row around).
  const listRef = React.useRef(null);
  const contentRef = React.useRef(null);
  const currentRowRef = React.useRef(null);
  const scrollModeRef = React.useRef('center');

  // Fractional vertical position (0..1) of every rendered row within the
  // scrollable content, keyed by commit id. Both the heat-gutter tick marks and
  // the "you are here" bar read from this one map, so they share a single
  // coordinate system and stay aligned. Measured from real DOM geometry rather
  // than list index, so the marks track the actual row positions through
  // collapsed groups and varying row heights (inert one-liners, tall group
  // headers) instead of an even index-based spread that drifts from them.
  const [rowFracs, setRowFracs] = React.useState(null);

  const selectCommit = React.useCallback((id) => { scrollModeRef.current = 'center'; setGroupSel(null); navigate(id); }, [navigate]);
  const selectFromList = React.useCallback((id) => { scrollModeRef.current = 'nearest'; setGroupSel(null); navigate(id); }, [navigate]);
  const displayItems = React.useMemo(() => buildDisplayItems(filteredRows), [filteredRows]);

  const sel = currentId ? byId[currentId] : chunks[0];

  // Re-center the active row whenever the selected commit changes. Clicking a
  // cell in the bottom heatmap (or any out-of-list jump) lands here and pulls
  // the matching dossier row into the middle of the visible area.
  React.useEffect(() => {
    const el = currentRowRef.current;
    if (!el) return;
    el.scrollIntoView({ block: scrollModeRef.current === 'nearest' ? 'nearest' : 'center', behavior: 'smooth' });
    scrollModeRef.current = 'center';
  }, [currentId]);

  // The sync arrow at the top of the scroll gutter: jump back to the open commit.
  const scrollToCurrent = React.useCallback(() => {
    const el = currentRowRef.current;
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  // Place every gutter mark at its row's true position in the content.
  // Content-relative (adds scrollTop), so the marks stay put as the list scrolls
  // and only move when the layout above them changes. One pass over all tagged
  // rows builds an id → fraction map the gutter and the "you are here" bar both
  // read from, guaranteeing the open-commit bar lines up with that commit's tick.
  const measureRows = React.useCallback(() => {
    const list = listRef.current;
    const content = contentRef.current;
    const h = list ? list.scrollHeight : 0;
    if (!list || !content || !h) { setRowFracs(null); return; }
    const listTop = list.getBoundingClientRect().top;
    const next = new Map();
    for (const node of content.querySelectorAll('[data-rowid]')) {
      const center = (node.getBoundingClientRect().top - listTop) + list.scrollTop + node.offsetHeight / 2;
      next.set(node.getAttribute('data-rowid'), Math.max(0, Math.min(1, center / h)));
    }
    setRowFracs(next);
  }, []);

  // Re-measure when the open commit changes, when the display list changes, and
  // — via a ResizeObserver on the content — whenever a group expands/collapses
  // or the pane resizes, so the marker tracks the highlighted row continuously.
  React.useLayoutEffect(() => {
    measureRows();
    const el = contentRef.current;
    const onResize = () => measureRows();
    window.addEventListener('resize', onResize);
    let ro;
    if (el && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onResize);
      ro.observe(el);
    }
    return () => { window.removeEventListener('resize', onResize); ro?.disconnect(); };
  }, [measureRows, currentId, displayItems, groupSel]);

  // The open commit's bar reads from the same measured map as the ticks.
  const currentFrac = rowFracs && sel ? rowFracs.get(sel.id) ?? null : null;

  return (
    <AppFrame
      topBar={<ScreenTabs />}
      coverageProps={{ ...coverage, showSuspicion: showAiSuspicion }}
      rightSlot={<TopBarControls />}
    >
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ width: paneWidths.inboxList, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <FilterBar
            kindSel={kindSel}
            flagSel={flagSel}
            classSel={classSel}
            fileFilter={fileFilter}
            setFileFilter={setFileFilter}
            toggleKind={toggleKind}
            toggleFlagTok={toggleFlagTok}
            toggleClass={toggleClass}
            resetFilters={resetFilters}
            counts={React.useMemo(() => facetCounts(chunks), [chunks])}
          />
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <div ref={listRef} style={{ flex: 1, overflow: 'auto' }}>
              <div ref={contentRef}>
              {displayItems.map((item) =>
                item.type === 'group' ? (
                  <GroupRow
                    key={item.key}
                    group={item.group}
                    currentGroup={groupSel && groupSel.id === item.group.id}
                    currentCommitId={!groupSel && sel ? sel.id : null}
                    currentRowRef={currentRowRef}
                    checkout={checkout}
                    onSelectGroup={() => { setGroupSel(item.group); recordFocus(`group:${item.group.id}`); }}
                    onSelectCommit={selectFromList}
                  />
                ) : (
                  <CommitRow
                    key={item.key}
                    row={item.row}
                    current={!groupSel && item.row.id === (sel && sel.id)}
                    innerRef={!groupSel && item.row.id === (sel && sel.id) ? currentRowRef : undefined}
                    checkedOut={checkout.lastSha && item.row.sha === checkout.lastSha}
                    pendingCheckout={checkout.pendingSha === item.row.sha}
                    onSelect={() => selectFromList(item.row.id)}
                    onHoldComplete={() => {
                      selectFromList(item.row.id);
                      checkout.checkout(item.row.sha, selectedInput);
                    }}
                    checkoutEnabled={checkout.enabled}
                  />
                )
              )}
              {filteredRows.length === 0 && (
                <div style={{ padding: 30, textAlign: 'center', fontFamily: WF.monoFont, color: WF.ink3 }}>
                  no commits match the current filter
                </div>
              )}
              </div>
            </div>
            <ScrollHeatGutter
              rows={filteredRows}
              rowFracs={rowFracs}
              currentFrac={currentFrac}
              onSync={scrollToCurrent}
              onPick={selectCommit}
            />
          </div>
        </div>

        <PaneResizer
          width={paneWidths.inboxList}
          setWidth={(w) => setPaneWidth('inboxList', w)}
          min={320}
          max={760}
          dflt={520}
          dir={1}
        />

        {groupSel ? (
          <GroupDossier group={groupSel} onSelectCommit={selectCommit} />
        ) : sel && (
          <DossierBody
            chunk={sel}
            byId={byId}
            checkedOut={checkout.lastSha && sel.sha === checkout.lastSha}
            pendingCheckout={checkout.pendingSha === sel.sha}
            checkoutEnabled={checkout.enabled}
            onCheckout={() => checkout.checkout(sel.sha, selectedInput)}
            onNavigate={selectCommit}
          />
        )}

        {!groupSel && sel && (
          <>
            <PaneResizer
              width={paneWidths.fileTimeline}
              setWidth={(w) => setPaneWidth('fileTimeline', w)}
              min={180}
              max={520}
              dflt={256}
              dir={-1}
            />
            <FileTimeline chunk={sel} byId={byId} onNavigate={selectCommit} width={paneWidths.fileTimeline} />
          </>
        )}
      </div>
    </AppFrame>
  );
}

// Per-facet occurrence counts across all commits, shown on each chip.
function facetCounts(chunks) {
  const kind = {}, flag = {}, cls = {};
  for (const c of chunks) {
    kind[c.kind] = (kind[c.kind] || 0) + 1;
    if (c.fileClass) cls[c.fileClass] = (cls[c.fileClass] || 0) + 1;
    for (const t of flagTokens(c)) flag[t] = (flag[t] || 0) + 1;
  }
  return { kind, flag, cls };
}

// A single multi-select filter chip; active = filled with the facet's accent.
function FacetChip({ active, style, label, count, onClick }) {
  return (
    <Chip
      style={{
        cursor: 'pointer',
        background: active ? style.fg : style.bg,
        color: active ? WF.paper : style.fg,
        borderColor: style.fg,
      }}
      onClick={onClick}
    >
      {style.glyph} {label} · {count}
    </Chip>
  );
}

// One labeled facet row: a fixed-width tag column, then its multi-select chips
// in a second column. A two-column grid (shared 44px label column across every
// row) so when chips wrap they stay left-aligned to their column's edge rather
// than sliding back under the label.
function FacetRow({ tag, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr', columnGap: 6, alignItems: 'baseline' }}>
      <L size={10} weight={700} mono color={WF.ink3}
        style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {tag}
      </L>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

// Three independent facets — change type, suspect/flag, file class — each a
// multi-select that defaults to "all" (nothing selected), plus a free-text
// file-name filter. The facets collapse behind a "filters" toggle so the list
// header stays one line; opening it expands the header block in place (pushing
// the list down) rather than floating over it. The trigger badges how many
// conditions are live and stays highlighted while any are, even when collapsed;
// reset clears every facet and the name query.
function FilterBar({ kindSel, flagSel, classSel, fileFilter, setFileFilter, toggleKind, toggleFlagTok, toggleClass, resetFilters, counts }) {
  const [open, setOpen] = React.useState(false);
  const fileActive = fileFilter.trim().length > 0;
  // Distinct conditions currently narrowing the list (each chip counts once,
  // the name query as one), shown on the trigger and used to enable reset.
  const activeCount =
    kindSel.size + flagSel.size + classSel.size + (fileActive ? 1 : 0);

  return (
    <div style={{ padding: '10px 12px', borderBottom: inkBorder(), display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <L size={13} weight={700}>commits</L>
        <div style={{ flex: 1 }} />
        <Chip
          aria-expanded={open}
          title={activeCount ? `${activeCount} filter${activeCount === 1 ? '' : 's'} applied — click to ${open ? 'collapse' : 'edit'}` : 'click to add filters'}
          onClick={() => setOpen((v) => !v)}
          style={{
            cursor: 'pointer',
            // Filled/highlighted whenever any filter is live, so the auditor can
            // see the list is narrowed even with the section collapsed. The caret
            // just tracks open/closed.
            background: activeCount ? WF.ink : open ? WF.paperAlt : 'transparent',
            color: activeCount ? WF.paper : WF.ink,
            borderColor: WF.ink,
            fontWeight: activeCount ? 700 : 500,
          }}
        >{open ? '▴' : '▾'} filters{activeCount ? ` · ${activeCount}` : ''}</Chip>
        <Chip
          style={{
            cursor: activeCount ? 'pointer' : 'default',
            background: 'transparent',
            color: activeCount ? WF.ink : WF.ink3,
            borderColor: activeCount ? WF.ink : WF.rule,
            opacity: activeCount ? 1 : 0.55,
          }}
          onClick={activeCount ? resetFilters : undefined}
        >↺ reset filters</Chip>
      </div>

      {open && (
        <>
          <FacetRow tag="change">
            {KIND_ORDER.filter((k) => counts.kind[k]).map((k) => (
              <FacetChip key={k} active={kindSel.has(k)} style={KIND_STYLE[k]}
                label={k.toLowerCase()} count={counts.kind[k]} onClick={() => toggleKind(k)} />
            ))}
          </FacetRow>

          <FacetRow tag="flag">
            {FLAG_ORDER.filter((t) => counts.flag[t]).map((t) => (
              <FacetChip key={t} active={flagSel.has(t)} style={FLAG_STYLE[t]}
                label={FLAG_STYLE[t].label} count={counts.flag[t]} onClick={() => toggleFlagTok(t)} />
            ))}
          </FacetRow>

          <FacetRow tag="class">
            {['code', 'data'].filter((t) => counts.cls[t]).map((t) => (
              <FacetChip key={t} active={classSel.has(t)} style={FILECLASS_STYLE[t]}
                label={FILECLASS_STYLE[t].label} count={counts.cls[t]} onClick={() => toggleClass(t)} />
            ))}
          </FacetRow>

          <div style={{ borderTop: inkBorder(1.2), margin: '2px -12px 0', padding: '9px 12px 0' }}>
            <FacetRow tag="file">
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="text"
                  value={fileFilter}
                  onChange={(e) => setFileFilter(e.target.value)}
                  placeholder="filter by file name…"
                  aria-label="filter commits by file name"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '4px 7px',
                    fontFamily: WF.monoFont,
                    fontSize: 12,
                    color: WF.ink,
                    background: WF.paper,
                    border: inkBorder(fileActive ? 1.5 : 1.2),
                    outline: 'none',
                  }}
                />
                {fileActive && (
                  <Chip
                    onClick={() => setFileFilter('')}
                    title="clear file-name filter"
                    style={{ cursor: 'pointer', background: 'transparent', color: WF.ink2, borderColor: WF.rule }}
                  >✕</Chip>
                )}
              </div>
            </FacetRow>
          </div>
        </>
      )}
    </div>
  );
}

// Marker color for a row in the scroll gutter, by descending salience.
// Suspect levels shade through the heat ramp; a deterministic pre-flag is a
// muted neutral note (not an alarm); an auditor's own flag is ink. Everything
// else is unmarked.
function gutterMark(r) {
  if (r.flagLevel === 'high') return WF.heat4;
  if (r.flagLevel === 'medium') return WF.heat3;
  if (r.flagLevel === 'low' || r.flagLevel === 'mild') return WF.heat2;
  if (r.flag) return WF.ink3;
  if (r.userFlagged) return WF.ink;
  return null;
}

// Thin minimap down the right edge of the left list. Tick lines mark suspect /
// pre-flagged / user-flagged rows at their position in the (filtered) list; a
// full-width ink bar marks where the open commit sits. The arrow at the top —
// Overleaf's code↔pdf sync button — scrolls the list back to that open commit.
function ScrollHeatGutter({ rows, rowFracs, currentFrac, onSync, onPick }) {
  const n = rows.length;
  // Prefer each row's measured position; fall back to its index spread for rows
  // not currently in the DOM (e.g. members of a collapsed group).
  const frac = (r, i) => rowFracs?.get(r.id) ?? (n <= 1 ? 0 : i / (n - 1));
  return (
    <div
      style={{
        width: 14,
        flex: 'none',
        borderLeft: `1px solid ${WF.rule}`,
        background: WF.paperAlt,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        onClick={onSync}
        title="scroll to the open commit"
        style={{
          height: 18,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderBottom: `1px solid ${WF.rule}`,
          background: WF.paper,
          cursor: 'pointer',
          color: WF.ink2,
          fontFamily: WF.monoFont,
          fontSize: 11,
          userSelect: 'none',
        }}
      >
        ◀
      </div>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {rows.map((r, i) => {
          const c = gutterMark(r);
          if (!c) return null;
          return (
            <div
              key={r.id}
              onClick={() => onPick(r.id)}
              title={`${r.kind.toLowerCase()} · ${r.sha ? r.sha.slice(0, 7) : '—'}${
                r.flagLevel ? ' · ' + r.flagLevel + ' suspicion' : r.flag ? ' · pre-flagged' : r.userFlagged ? ' · your flag' : ''
              }`}
              style={{
                position: 'absolute',
                left: 1,
                right: 1,
                top: `${frac(r, i) * 100}%`,
                height: 2,
                background: c,
                cursor: 'pointer',
              }}
            />
          );
        })}
        {currentFrac != null && (
          <div
            aria-hidden
            title="open commit"
            style={{
              position: 'absolute',
              left: -1,
              right: -1,
              top: `${currentFrac * 100}%`,
              height: 3,
              marginTop: -1,
              background: WF.ink,
              boxShadow: `0 0 0 1px ${WF.paper}`,
            }}
          />
        )}
      </div>
    </div>
  );
}

function CommitRow({ row, current, checkedOut, pendingCheckout, onSelect, onHoldComplete, checkoutEnabled, innerRef }) {
  const [holdMs, setHoldMs] = React.useState(0);
  const holdingRef = React.useRef(null);     // { timer, raf, started, suppressed }

  const cancelHold = React.useCallback(() => {
    const h = holdingRef.current;
    if (!h) return;
    clearTimeout(h.timer);
    cancelAnimationFrame(h.raf);
    holdingRef.current = null;
    setHoldMs(0);
  }, []);

  React.useEffect(() => () => cancelHold(), [cancelHold]);

  const onPointerDown = (e) => {
    if (!checkoutEnabled) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const started = performance.now();
    const tick = () => {
      const h = holdingRef.current;
      if (!h) return;
      setHoldMs(Math.min(HOLD_MS, performance.now() - started));
      h.raf = requestAnimationFrame(tick);
    };
    const raf = requestAnimationFrame(tick);
    const timer = setTimeout(() => {
      // Suppress the trailing click so we don't double-fire navigate().
      const h = holdingRef.current;
      if (h) h.fired = true;
      cancelHold();
      onHoldComplete();
    }, HOLD_MS);
    holdingRef.current = { timer, raf, started, fired: false };
  };

  const onPointerUp = () => { cancelHold(); };
  const onPointerLeave = () => { cancelHold(); };
  const onPointerCancel = () => { cancelHold(); };

  const onClick = (e) => {
    // If the hold gesture fired we already navigated + checked out.
    const wasHoldFire = holdingRef.current?.fired;
    if (wasHoldFire) {
      e.preventDefault();
      return;
    }
    onSelect();
  };

  const style = KIND_STYLE[row.kind] || KIND_STYLE.SYNC;
  // Show the code/data badge for file-touching events (create/modify/delete).
  const fcStyle =
    (row.kind === 'CREATE' || row.kind === 'DELETE' || row.kind === 'MODIFY') && row.fileClass
      ? FILECLASS_STYLE[row.fileClass]
      : null;
  const levelStyle = row.flagLevel ? LEVEL_STYLE[row.flagLevel] : null;
  const baseBg = current
    ? WF.paperAlt
    : (row.flagLevel === 'high' ? WF.rowHigh
      : row.flagLevel === 'medium' ? WF.rowMed
      : row.flag ? WF.paperAlt
      : WF.paper);
  const dim = row.visited && !current;
  // Non-invasive (read-only) commits collapse to a compact, dimmed single
  // line to save vertical space — but only when nothing flags them as
  // impactful. `mutating === undefined` (no sidecar) keeps the full row.
  const inert = row.mutating === false && !row.flag && !row.flagLevel && !row.userFlagged && !current;
  const holdPct = holdMs / HOLD_MS;

  // Display preferences. The primary line is the touched file (row.title)
  // unless the auditor opted to lead with the annotation's short title; the
  // greyed secondary line is selectable (operation / short title / clipped
  // description / none).
  const { inboxSubline, inboxTitleFromShortTitle } = useSettings();
  const mainTitle =
    (inboxTitleFromShortTitle && row.shortTitle ? row.shortTitle : row.title) || '(untitled)';
  const subline =
    inboxSubline === 'none' ? ''
    : inboxSubline === 'shortTitle' ? row.shortTitle
    : inboxSubline === 'annotation' ? clipText(row.annotationText, 120)
    : row.summary;  // 'operation' (default)

  return (
    <div
      ref={innerRef}
      data-rowid={row.id}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
      title={checkoutEnabled ? 'click to select · hold 3s to git checkout' : 'click to select'}
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: '28px 28px 1fr auto',
        gap: 10,
        alignItems: inert ? 'center' : 'start',
        padding: inert ? '3px 12px' : '10px 12px',
        borderBottom: `1px solid ${WF.rule}`,
        background: baseBg,
        boxShadow: current ? `inset 3px 0 0 ${WF.ink}` : undefined,
        opacity: dim ? 0.5 : (inert ? 0.6 : 1),
        cursor: 'pointer',
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      {holdMs > 0 && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: `linear-gradient(to right, ${WF.heat4}33 0%, ${WF.heat4}33 ${holdPct * 100}%, transparent ${holdPct * 100}%, transparent 100%)`,
          }}
        />
      )}
      <Check on={row.visited} />
      {inert ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: WF.ink3,
            fontFamily: WF.monoFont,
            fontSize: 12,
          }}
          title={(row.kindLabel || row.kind).toLowerCase()}
        >
          {style.glyph}
        </div>
      ) : (
        <div
          style={{
            width: 24,
            height: 24,
            background: style.bg,
            border: `1.5px solid ${style.fg}`,
            color: style.fg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: WF.monoFont,
            fontSize: 14,
            fontWeight: 700,
          }}
          title={(row.kindLabel || row.kind).toLowerCase()}
        >
          {style.glyph}
        </div>
      )}
      {inert ? (
        <div
          style={{
            minWidth: 0,
            display: 'flex',
            gap: 8,
            alignItems: 'baseline',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          <L mono size={10} color={WF.ink3} weight={700} style={{ flex: 'none' }}>{row.kindLabel || row.kind}</L>
          {fcStyle && (
            <L mono size={10} color={fcStyle.fg} weight={700} style={{ flex: 'none' }} title={fcStyle.title}>{fcStyle.label}</L>
          )}
          <Sha sha={row.sha} size={10} color={WF.ink3} style={{ flex: 'none' }} />
          <L
            size={12}
            color={WF.ink3}
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >{mainTitle}</L>
        </div>
      ) : (
      <div style={{ minWidth: 0, position: 'relative' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <L mono size={11} color={style.fg} weight={700}>{row.kindLabel || row.kind}</L>
          {fcStyle && (
            <Chip
              style={{ background: fcStyle.bg, color: fcStyle.fg, borderColor: fcStyle.fg }}
              title={fcStyle.title}
            >{fcStyle.glyph} {fcStyle.label}</Chip>
          )}
          <Sha sha={row.sha} size={10} color={WF.ink3} />
          {checkedOut && <Chip style={{ background: WF.ink, color: WF.paper, borderColor: WF.ink }}>HEAD</Chip>}
          {pendingCheckout && (
            <Chip style={{ background: WF.heat3, color: WF.onAccent, borderColor: WF.heat3, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              checking out <Dots size={4} color={WF.onAccent} />
            </Chip>
          )}
          {levelStyle && (
            <Chip
              style={{ background: levelStyle.bg, color: levelStyle.fg, borderColor: levelStyle.bg }}
              title={(row.suspicions[0]?.category || 'flagged') + (row.suspicionAgg?.agreement_count > 1 ? ` · ${row.suspicionAgg.agreement_count} agents` : '')}
            >{levelStyle.label}</Chip>
          )}
          {row.flag && <Chip style={{ background: WF.paperAlt, color: WF.ink2, borderColor: WF.rule2 }} title="heuristic note (not a verdict): produced-then-deleted output — common in iteration, and possibly a logging-process artifact">ⓘ note · {row.flag.kind}</Chip>}
          {row.userFlagged && !row.flag && !levelStyle && <Chip style={{ background: WF.userflag, color: WF.onAccent, borderColor: WF.userflag }}>user flagged</Chip>}
        </div>
        <L
          size={13}
          style={{
            display: 'block',
            marginTop: 4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >{mainTitle}</L>
        {subline && (
          <L
            size={11}
            color={WF.ink3}
            mono
            style={{
              display: 'block',
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >{subline}</L>
        )}
      </div>
      )}
      <Stamp size={11} color={WF.ink3} style={{ textAlign: 'right' }}>{fmtClock(row.t)}</Stamp>
    </div>
  );
}

// Presentation for a deterministically-parsed group, keyed on classify's
// `group_kind`. Open-set: an unknown kind still renders with the default.
const GROUP_KIND = {
  creation_sequence: { glyph: '+', label: 'creation sequence',      bg: WF.tagGreenBg, fg: WF.tagGreenFg },
  edit_sequence:     { glyph: '~', label: 'edit sequence',          bg: WF.tagAmberBg, fg: WF.tagAmberFg },
  dir_deletion:      { glyph: '-', label: 'directory deletion',     bg: WF.tagRedBg, fg: WF.heat4 },
  file_deletion:     { glyph: '-', label: 'multiple files deleted', bg: WF.tagRedBg, fg: WF.heat4 },
  default:           { glyph: '▦', label: 'commit group',           bg: WF.paperAlt, fg: WF.ink2 },
};
const groupMeta = (kind) => GROUP_KIND[kind] || GROUP_KIND.default;

// File-class descriptor for a whole group, used to name it in the main title:
// "data commit group" / "code commit group". Reuses the per-commit code/data
// palette for coloring. A group qualifies only when it is *entirely* one class
// — every classifiable member must agree. Returns null otherwise (mixed source
// + artifacts, or no member with a usable extension, e.g. a directory deletion
// of extensionless paths), and the title falls back to the group_kind label.
const GROUP_CLASS_STYLE = {
  data: { fg: FILECLASS_STYLE.data.fg, label: 'data commit group', title: 'every classified member touches data / results artifacts (json, png, …)' },
  code: { fg: FILECLASS_STYLE.code.fg, label: 'code commit group', title: 'every classified member edits authored source' },
};

// 'data' | 'code' when the whole group is that one class, else null.
function groupFileClass(members) {
  let code = 0, data = 0;
  for (const m of members || []) {
    if (m.fileClass === 'code') code++;
    else if (m.fileClass === 'data') data++;
  }
  if (data && !code) return 'data';
  if (code && !data) return 'code';
  return null;  // mixed, or nothing classifiable
}

// Severity ordering for rolling member flags up to the group level.
const LEVEL_RANK = { high: 4, medium: 3, low: 2, mild: 1 };

// Namespaced overlay key for group-level auditor markups (flag + notes), so a
// group can be flagged / annotated as a whole alongside (and independent of)
// its members. Mirrors the area:/thread: keys in the semantic-areas screen.
const groupFlagKey = (id) => `group:${id}`;

// The flag a single member commit carries, as a small badge spec, by descending
// salience: a narrator suspicion level, then a deterministic pre-flag, then the
// auditor's own flag. null ⇒ the member is clean. Mirrors gutterMark / the
// CommitRow chips so a member reads the same collapsed inside a group as it
// would standalone.
function memberFlagMark(m) {
  if (m.flagLevel) {
    const s = LEVEL_STYLE[m.flagLevel] || LEVEL_STYLE.low;
    return { bg: s.bg, fg: s.fg, label: s.label, accent: s.bg };
  }
  if (m.flag) return { bg: WF.paperAlt, fg: WF.ink2, label: 'ⓘ ' + (m.flag.kind || 'note'), accent: WF.ink3 };
  if (m.userFlagged) return { bg: WF.userflag, fg: WF.onAccent, label: 'user flagged', accent: WF.userflag };
  return null;
}

// Roll member flags up to a group-level summary so a collapsed group can warn
// that something inside it needs review: the worst suspicion level present, plus
// tallies of suspect / pre-flagged / your-flagged members. flaggedCount counts
// distinct members carrying any flag. Returns null when the group is clean.
function groupFlagSummary(members) {
  let maxLevel = null, maxRank = 0;
  let suspectCount = 0, preFlagCount = 0, userCount = 0, flaggedCount = 0;
  for (const m of members || []) {
    let touched = false;
    if (m.flagLevel) {
      suspectCount++; touched = true;
      const r = LEVEL_RANK[m.flagLevel] || 0;
      if (r > maxRank) { maxRank = r; maxLevel = m.flagLevel; }
    }
    if (m.flag) { preFlagCount++; touched = true; }
    if (m.userFlagged) { userCount++; touched = true; }
    if (touched) flaggedCount++;
  }
  if (flaggedCount === 0) return null;
  // Group-badge styling tracks the worst thing inside it.
  const style = maxLevel
    ? LEVEL_STYLE[maxLevel]
    : preFlagCount > 0
      ? { bg: WF.paperAlt, fg: WF.ink2, label: 'ⓘ notes' }
      : { bg: WF.ink, fg: WF.paper, label: '⚠ flagged' };
  return { maxLevel, suspectCount, preFlagCount, userCount, flaggedCount, style };
}

// Collapse a chronologically-ordered row list into display items: a contiguous
// run of >= 2 rows sharing a non-null groupId becomes one { type:'group' }
// item; everything else stays a { type:'commit' } item. Members are already in
// chronological order, so members[0] is the oldest commit and the last newest.
function buildDisplayItems(rows) {
  const items = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.groupId) {
      let j = i + 1;
      while (j < rows.length && rows[j].groupId === r.groupId) j++;
      if (j - i >= 2) {
        const members = rows.slice(i, j);
        const m0 = members[0];
        const mN = members[members.length - 1];
        items.push({
          type: 'group',
          key: 'grp:' + r.groupId,
          group: {
            id: r.groupId,
            kind: m0.groupKind,
            root: m0.groupRoot,
            members,
            fromSha: m0.sha,   // oldest — base for the cumulative diff
            toSha: mN.sha,     // newest — target for the cumulative diff
            tStart: m0.t,
            tEnd: mN.t,
          },
        });
        i = j;
        continue;
      }
    }
    items.push({ type: 'commit', key: r.id, row: r });
    i++;
  }
  return items;
}

// Left-pane collapsed group: a regular-sized header naming the group, plus its
// member commits as small, dimmed, indented sub-rows. Clicking the header
// selects the group (→ cumulative diff); clicking a sub-row opens that commit.
function GroupRow({ group, currentGroup, currentCommitId, currentRowRef, checkout, onSelectGroup, onSelectCommit }) {
  const [open, setOpen] = React.useState(true);
  const { flaggedOverlay = {} } = useData();
  const meta = groupMeta(group.kind);
  const n = group.members.length;
  const flagSummary = React.useMemo(() => groupFlagSummary(group.members), [group.members]);
  const cls = groupFileClass(group.members);
  const clsStyle = cls ? GROUP_CLASS_STYLE[cls] : null;
  const fcStyle = cls ? FILECLASS_STYLE[cls] : null;
  const titleLabel = clsStyle ? clsStyle.label : meta.label;
  const userGroupFlagged = !!flaggedOverlay[groupFlagKey(group.id)];

  return (
    <div
      style={{
        borderBottom: `1px solid ${WF.rule}`,
        background: currentGroup
          ? WF.paperAlt
          : (userGroupFlagged || flagSummary) ? WF.mark : WF.paper,
      }}
    >
      <div
        onClick={onSelectGroup}
        title={
          flagSummary
            ? `select group → cumulative diff · ${flagSummary.flaggedCount} of ${n} commits flagged`
            : 'select group → cumulative diff across all member commits'
        }
        style={{
          display: 'grid',
          gridTemplateColumns: '28px 28px 1fr auto auto',
          gap: 10,
          alignItems: 'center',
          padding: '10px 12px',
          cursor: 'pointer',
          userSelect: 'none',
          boxShadow: currentGroup
            ? `inset 3px 0 0 ${WF.ink}`
            : userGroupFlagged
              ? `inset 3px 0 0 ${WF.ink}`
              : flagSummary
                ? `inset 3px 0 0 ${flagSummary.style.bg}`
                : undefined,
        }}
      >
        <div
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          title={open ? 'hide member commits' : 'show member commits'}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: WF.ink2, fontSize: 12 }}
        >
          {open ? '▾' : '▸'}
        </div>
        <div
          style={{
            width: 24, height: 24, background: meta.bg, border: `1.5px solid ${meta.fg}`,
            color: meta.fg, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13,
          }}
          title={group.kind || 'group'}
        >
          {meta.glyph}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <L mono size={11} color={clsStyle ? clsStyle.fg : meta.fg} weight={700} title={clsStyle?.title}>{titleLabel}</L>
            {fcStyle && (
              <Chip
                style={{ background: fcStyle.bg, color: fcStyle.fg, borderColor: fcStyle.fg }}
                title={fcStyle.title}
              >{fcStyle.glyph} {fcStyle.label}</Chip>
            )}
            <Chip style={{ background: meta.bg, color: meta.fg, borderColor: meta.fg }}>{n} commits</Chip>
          </div>
          <L
            size={13}
            style={{ display: 'block', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >{group.root || '(group)'}</L>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          {userGroupFlagged && (
            <Chip
              style={{ background: WF.ink, color: WF.paper, borderColor: WF.ink }}
              title="auditor flagged this whole group"
            >[!] group flagged</Chip>
          )}
          {flagSummary && (
            <Chip
              style={{ background: flagSummary.style.bg, color: flagSummary.style.fg, borderColor: flagSummary.style.bg }}
              title={[
                flagSummary.suspectCount && `${flagSummary.suspectCount} suspect`,
                flagSummary.preFlagCount && `${flagSummary.preFlagCount} pre-flagged`,
                flagSummary.userCount && `${flagSummary.userCount} your flag`,
              ].filter(Boolean).join(' · ')}
            >⚠ {flagSummary.flaggedCount} of {n} flagged</Chip>
          )}
        </div>
        <Stamp size={11} color={WF.ink3} style={{ textAlign: 'right' }}>{fmtClock(group.tStart)}</Stamp>
      </div>

      {open && group.members.map((m) => {
        const isCur = m.id === currentCommitId;
        const isHead = checkout && checkout.lastSha && m.sha === checkout.lastSha;
        const mark = memberFlagMark(m);
        return (
          <div
            key={m.id}
            ref={isCur ? currentRowRef : undefined}
            data-rowid={m.id}
            onClick={() => onSelectCommit(m.id)}
            title={mark ? `open this commit · ${mark.label}` : 'open this individual commit'}
            style={{
              display: 'grid',
              gridTemplateColumns: '56px 1fr auto auto',
              gap: 8,
              alignItems: 'baseline',
              padding: '2px 12px 2px 40px',
              cursor: 'pointer',
              background: isCur ? WF.paperAlt : mark ? WF.mark : 'transparent',
              boxShadow: isCur
                ? `inset 3px 0 0 ${WF.ink2}`
                : mark ? `inset 3px 0 0 ${mark.accent}` : undefined,
              opacity: m.visited && !isCur ? 0.55 : 0.8,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            <Sha keepSlot sha={m.sha} size={10} color={isHead ? WF.ink : WF.ink3} weight={isHead ? 700 : 400} />
            <L
              size={11}
              color={WF.ink3}
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >{m.title || '(untitled)'}</L>
            {mark ? (
              <Chip
                style={{ background: mark.bg, color: mark.fg, borderColor: mark.bg, alignSelf: 'center' }}
                title={mark.label}
              >{mark.label}</Chip>
            ) : <span />}
            <Stamp size={10} color={WF.ink3} style={{ textAlign: 'right' }}>{fmtClock(m.t)}</Stamp>
          </div>
        );
      })}
    </div>
  );
}

// Total annotations attached to a group — group-level (annotationsByGroup) plus
// every member commit's own. Drives GroupDossier's decision to pair the
// annotations box beside the member-commits box rather than stack it.
function groupAnnotationCount(data, group) {
  const groupAnnos = (data?.annotationsByGroup && data.annotationsByGroup[group.id]) || [];
  let memberCount = 0;
  for (const m of group.members || []) memberCount += (m.annotations || []).length;
  return groupAnnos.length + memberCount;
}

const memberPath = (m) => m.file || m.title || '';

// Build a directory tree from the members' file paths. Each directory node
// holds child dirs (`children`) and the files living directly in it (`leaves`,
// each keeping its member commit so the row stays clickable + typed). A file
// touched twice (e.g. created then later modified) pushes two leaves under the
// same dir, so repeats survive as sibling rows rather than being collapsed.
function buildMemberTree(members) {
  const root = { name: '', children: new Map(), leaves: [] };
  const sorted = [...members].sort((a, b) => memberPath(a).localeCompare(memberPath(b)));
  for (const m of sorted) {
    const segs = memberPath(m).split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const dir = segs[i];
      if (!node.children.has(dir)) node.children.set(dir, { name: dir, children: new Map(), leaves: [] });
      node = node.children.get(dir);
    }
    node.leaves.push({ name: segs[segs.length - 1] || memberPath(m), member: m });
  }
  return root;
}

// Collapse a single-child directory chain into one label (a/b/c), and fold a
// terminal directory holding exactly one file into that file's row, so a lone
// deep path stays on one line (g/h/i.png) instead of laddering down.
function collapseDir(node) {
  let label = node.name, cur = node;
  while (cur.leaves.length === 0 && cur.children.size === 1) {
    const [child] = cur.children.values();
    label += '/' + child.name;
    cur = child;
  }
  if (cur.children.size === 0 && cur.leaves.length === 1) {
    return { label: `${label}/${cur.leaves[0].name}`, terminalLeaf: cur.leaves[0], node: cur };
  }
  return { label, terminalLeaf: null, node: cur };
}

// Flatten the tree to display rows carrying the same box-drawing prefixes
// `tree(1)` draws (├──, └──, │, spaces). Directory rows are structural (dimmed,
// not clickable); leaf rows carry their member commit. A shared top directory
// is hoisted to a bare prefix-less header so it doesn't cost an indent level.
function flattenMemberTree(root) {
  const rows = [];
  let n = 0;
  let base = root, header = '';
  while (base.leaves.length === 0 && base.children.size === 1) {
    const [child] = base.children.values();
    header = header ? `${header}/${child.name}` : child.name;
    base = child;
  }
  if (header) rows.push({ kind: 'dir', key: `d${n++}`, prefix: '', label: `${header}/` });
  const walk = (node, prefix) => {
    const items = [
      ...[...node.children.values()].map((d) => ({ sort: d.name, dir: d })),
      ...node.leaves.map((l) => ({ sort: l.name, leaf: l })),
    ].sort((a, b) => a.sort.localeCompare(b.sort));
    items.forEach((it, i) => {
      const last = i === items.length - 1;
      const conn = prefix + (last ? '└── ' : '├── ');
      if (it.dir) {
        const { label, terminalLeaf, node: inner } = collapseDir(it.dir);
        if (terminalLeaf) {
          rows.push({ kind: 'leaf', key: `l${n++}`, prefix: conn, label, member: terminalLeaf.member, path: memberPath(terminalLeaf.member) });
        } else {
          rows.push({ kind: 'dir', key: `d${n++}`, prefix: conn, label: `${label}/` });
          walk(inner, prefix + (last ? '    ' : '│   '));
        }
      } else {
        rows.push({ kind: 'leaf', key: `l${n++}`, prefix: conn, label: it.leaf.name, member: it.leaf.member, path: memberPath(it.leaf.member) });
      }
    });
  };
  walk(base, '');
  return rows;
}

// The group dossier's clickable member-commit list, in its own box. `style`
// lets GroupDossier size it as a flex column when it pairs with the annotations
// box side by side.
function MemberCommitsBox({ members, onSelectCommit, style }) {
  // Groups whose members are all file paths (commit groups + deletion groups)
  // render as a real directory tree sorted by path — independent of the SHA
  // toggle: with hashes on the tree gets a leading short-SHA column, with them
  // off the tree slides left to fill the gap. Mixed / command groups fall back
  // to the flat title list.
  const { showCommitHashes } = useSettings();
  const treeMode = members.length > 0
    && members.every((m) => {
      const p = memberPath(m);
      return p.includes('/') || /\.[\w]+$/.test(p);
    });
  // One grid template for every tree row (dir + leaf) so the path column — and
  // therefore the box-drawing prefix — lines up whether or not the SHA shows.
  const treeCols = showCommitHashes ? '64px 1fr auto 84px' : '1fr auto 84px';
  const treeRows = React.useMemo(
    () => (treeMode ? flattenMemberTree(buildMemberTree(members)) : null),
    [members, treeMode],
  );
  // Shared cell style: monospace, preserve the prefix's spacing, ellipsize a
  // long name on the right rather than wrap the tree.
  const cell = { whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis' };
  return (
    <Box style={{ padding: 10, ...style }}>
      <L size={12} weight={600}>member commits / modified files ({members.length})</L>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column' }}>
        {treeMode
          ? treeRows.map((r) => {
              if (r.kind === 'dir') {
                return (
                  <div key={r.key} style={{ display: 'grid', gridTemplateColumns: treeCols, gap: 8, alignItems: 'baseline', padding: '2px 4px' }}>
                    {showCommitHashes && <span />}
                    <L mono size={11} color={WF.ink3} style={cell}>{r.prefix}{r.label}</L>
                    <span />
                    <span />
                  </div>
                );
              }
              const mark = memberFlagMark(r.member);
              return (
                <div
                  key={r.key}
                  onClick={() => onSelectCommit(r.member.id)}
                  title={r.path + (mark ? ` · ${mark.label}` : '')}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: treeCols,
                    gap: 8,
                    alignItems: 'baseline',
                    padding: '2px 4px',
                    cursor: 'pointer',
                    borderBottom: `1px solid ${WF.rule}`,
                    background: mark ? WF.mark : undefined,
                    boxShadow: mark ? `inset 3px 0 0 ${mark.accent}` : undefined,
                  }}
                >
                  {showCommitHashes && <Sha sha={r.member.sha} len={8} size={11} color={WF.ink2} />}
                  <L mono size={11} color={WF.ink2} style={cell}>{r.prefix}{r.label}</L>
                  {mark ? (
                    <Chip style={{ background: mark.bg, color: mark.fg, borderColor: mark.bg, alignSelf: 'center' }} title={mark.label}>{mark.label}</Chip>
                  ) : <span />}
                  <Stamp size={10} color={WF.ink3} style={{ textAlign: 'right' }}>{fmtClock(r.member.t)}</Stamp>
                </div>
              );
            })
          : members.map((m) => {
              const mark = memberFlagMark(m);
              return (
                <div
                  key={m.id}
                  onClick={() => onSelectCommit(m.id)}
                  title={mark ? `open this commit · ${mark.label}` : 'open this individual commit'}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: showCommitHashes ? '64px 1fr auto 84px' : '1fr auto 84px',
                    gap: 8,
                    alignItems: 'baseline',
                    padding: '3px 4px',
                    cursor: 'pointer',
                    borderBottom: `1px solid ${WF.rule}`,
                    background: mark ? WF.mark : undefined,
                    boxShadow: mark ? `inset 3px 0 0 ${mark.accent}` : undefined,
                  }}
                >
                  {showCommitHashes && <Sha sha={m.sha} len={8} size={11} color={WF.ink2} />}
                  <L size={11} color={WF.ink2} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.title || '(untitled)'}
                  </L>
                  {mark ? (
                    <Chip style={{ background: mark.bg, color: mark.fg, borderColor: mark.bg, alignSelf: 'center' }} title={mark.label}>{mark.label}</Chip>
                  ) : <span />}
                  <Stamp size={10} color={WF.ink3} style={{ textAlign: 'right' }}>{fmtClock(m.t)}</Stamp>
                </div>
              );
            })}
      </div>
    </Box>
  );
}

// The right-aligned action column shared by the commit and group dossiers: the
// flag toggle (optionally preceded by `lead` chips such as git-checkout) with the
// group/tag editor stacked directly beneath it. The tag input shows by default,
// so tagging is one click away whether or not the item is already flagged —
// adding a tag flags the item (tag-as-flag, see tagTarget).
function FlagTagColumn({ flagged, label, title, onToggle, targetKey, noun, lead = null, minWidth = 220 }) {
  const bigChip = { fontSize: 16, padding: '6px 12px', borderRadius: 3 };
  return (
    <div style={{ flexShrink: 0, minWidth, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* checkout + flag stay on one row; the column grows to fit them (never
          wraps the flag below the git-checkout) and the tag editor fills it. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'nowrap' }}>
        {lead}
        <Chip
          style={{ ...bigChip, cursor: 'pointer' }}
          bg={flagged ? WF.heat4 : 'transparent'}
          color={flagged ? WF.paper : WF.ink}
          onClick={onToggle}
          title={title}
        >{label}</Chip>
      </div>
      <TagEditor targetKey={targetKey} placeholder="enter tag…" />
      <TagFlagsHint noun={noun} />
    </div>
  );
}

// Right-pane dossier for a selected group: identity header, a clickable member
// list, and the cumulative patch the whole group produced.
function GroupDossier({ group, onSelectCommit }) {
  const { data, flaggedOverlay = {}, userNotesOverlay = {}, toggleFlag } = useData();
  const meta = groupMeta(group.kind);
  const bigChip = { fontSize: 16, padding: '6px 12px', borderRadius: 3 };
  const n = group.members.length;
  const flagSummary = React.useMemo(() => groupFlagSummary(group.members), [group.members]);
  const cls = React.useMemo(() => groupFileClass(group.members), [group.members]);
  const clsStyle = cls ? GROUP_CLASS_STYLE[cls] : null;
  const fcStyle = cls ? FILECLASS_STYLE[cls] : null;
  const titleLabel = clsStyle ? clsStyle.label : meta.label;
  // The annotations box collapses to nothing when the group carries no group-
  // level or member annotations; only then does it pair side-by-side with the
  // member-commits box (matching DossierBody's annotations/threads split).
  const hasAnnos = groupAnnotationCount(data, group) > 0;
  const flagKey = groupFlagKey(group.id);
  const userGroupFlagged = !!flaggedOverlay[flagKey];
  const groupNotes = userNotesOverlay[flagKey] || [];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'auto' }}>
      <div style={{ padding: 14, borderBottom: inkBorder() }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Chip style={{ ...bigChip, background: meta.bg, color: clsStyle ? clsStyle.fg : meta.fg, borderColor: clsStyle ? clsStyle.fg : meta.fg }} title={clsStyle?.title}>
                {meta.glyph} {titleLabel}
              </Chip>
              {fcStyle && (
                <Chip
                  style={{ ...bigChip, background: fcStyle.bg, color: fcStyle.fg, borderColor: fcStyle.fg }}
                  title={fcStyle.title}
                >{fcStyle.glyph} {fcStyle.label}</Chip>
              )}
              <Sha size={13} weight={700} text={`${group.fromSha.slice(0, 7)} … ${group.toSha.slice(0, 7)}`} />
              <Chip>{n} commits</Chip>
              <Stamp size={12} color={WF.ink2}>{fmtFullClock(group.tStart)} → {fmtClock(group.tEnd)}</Stamp>
              {flagSummary && (
                <Chip
                  style={{ ...bigChip, background: flagSummary.style.bg, color: flagSummary.style.fg, borderColor: flagSummary.style.bg }}
                  title={[
                    flagSummary.suspectCount && `${flagSummary.suspectCount} suspect`,
                    flagSummary.preFlagCount && `${flagSummary.preFlagCount} pre-flagged`,
                    flagSummary.userCount && `${flagSummary.userCount} your flag`,
                  ].filter(Boolean).join(' · ')}
                >⚠ {flagSummary.flaggedCount} of {n} flagged</Chip>
              )}
            </div>
            <L size={16} weight={700} style={{ display: 'block', marginTop: 10 }}>{group.root || '(group)'}</L>
            <L size={12} color={WF.ink2} style={{ display: 'block', marginTop: 4 }}>
              {n} commits collapsed deterministically by the classify pipeline (group_kind: {group.kind})
              {cls === 'data'
                ? ' — every member touches data / results artifacts (json, png, …), not source'
                : cls === 'code'
                  ? ' — every member edits authored source'
                  : ''}. The diff below
              is the cumulative net change across all of them; click any member to inspect it on its own.
            </L>
          </div>
          {/* Flag + tag the whole group, with the tag editor stacked right under
              the flag (visible by default; adding a tag flags the group). */}
          <FlagTagColumn
            flagged={userGroupFlagged}
            label={userGroupFlagged ? '[!] flagged' : '[ ] flag group'}
            title={userGroupFlagged ? 'remove your flag on this group' : 'flag the whole group for review'}
            onToggle={() => toggleFlag(flagKey)}
            targetKey={flagKey}
            noun="group"
          />
        </div>
      </div>

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Member list beside the group's annotations and the auditor's own
            notes on the whole group (two-per-row tiles); when an optional tile
            is absent the remaining ones fill the row. */}
        <Tiles>
          <MemberCommitsBox members={group.members} onSelectCommit={onSelectCommit} />
          {hasAnnos && <GroupAnnotations group={group} onSelectCommit={onSelectCommit} />}
          <GroupValidatorNotes flagKey={flagKey} notes={groupNotes} flagged={userGroupFlagged} />
        </Tiles>

        <CumulativeDiffPanel from={group.fromSha} to={group.toSha} />
        {/* change-by-change progression hidden — groups show just the net change.
            Re-enable by restoring this and wrapping the cumulative diff in
            <CumulativeDiffPanel ... collapsible /> alongside it:
            {group.kind === 'edit_sequence' && (
              <StepwiseSequencePanel group={group} onSelectCommit={onSelectCommit} />
            )} */}
      </div>
    </div>
  );
}

// Cumulative patch across a group via /api/groupdiff (git diff <from>~1 <to>).
// Reuses the single-commit parseDiff / DiffGroup renderers. After-images resolve
// against the group tip `to`; before-images against the diff base `from~1` (not
// `to~1`), so blobs deleted partway through the group still render.
function CumulativeDiffPanel({ from, to, collapsible = false, defaultOpen = true }) {
  const { selectedInput } = useData();
  const [open, setOpen] = React.useState(collapsible ? defaultOpen : true);
  const [state, setState] = React.useState({ status: 'loading', text: '', error: null });

  const fetchDiff = React.useCallback(async () => {
    setState({ status: 'loading', text: '', error: null });
    try {
      const r = await fetch(`/api/groupdiff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${nameParam(selectedInput)}`);
      const text = await r.text();
      if (!r.ok) throw new Error(text || `HTTP ${r.status}`);
      setState({ status: 'ready', text, error: null });
    } catch (err) {
      setState({ status: 'error', text: '', error: err.message });
    }
  }, [from, to, selectedInput]);

  // Defer the fetch until the panel is open, so a collapsed "net change"
  // summary costs nothing until the auditor expands it.
  React.useEffect(() => { if (open) fetchDiff(); }, [fetchDiff, open]);

  const parsed = React.useMemo(() => (state.status === 'ready' ? parseDiff(state.text) : null), [state.status, state.text]);

  return (
    <Box style={{ padding: 12 }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: collapsible ? 'pointer' : 'default' }}
        onClick={collapsible ? () => setOpen((v) => !v) : undefined}
        title={collapsible ? (open ? 'hide net change' : 'show net change') : undefined}
      >
        {collapsible && <L mono size={12} color={WF.ink2}>{open ? '▾' : '▸'}</L>}
        <L size={13} weight={700}>{collapsible ? 'net change' : 'cumulative diff'}</L>
        <Sha size={10} color={WF.ink3} text={`${from.slice(0, 7)}~1 … ${to.slice(0, 7)}`} />
        {open && parsed && (
          <L mono size={10} color={WF.ink3}>
            · {parsed.logs.length} log file{parsed.logs.length === 1 ? '' : 's'} · {parsed.other.length} other
          </L>
        )}
        <div style={{ flex: 1 }} />
        {open && (
          <Chip style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); fetchDiff(); }}>reload</Chip>
        )}
      </div>
      {open && state.status === 'loading' && (
        <LoadingBox label="loading net diff" height={64} style={{ marginTop: 8 }} />
      )}
      {open && state.status === 'error' && (
        <L mono size={11} color={WF.heat4} style={{ display: 'block', marginTop: 8 }}>error: {state.error}</L>
      )}
      {open && state.status === 'ready' && parsed && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {parsed.other.length > 0 && (
            <DiffGroup title="files" accent={WF.ink} files={parsed.other} sha={to} oldSha={`${from}~1`} />
          )}
          {parsed.logs.length > 0 && (
            <LogDiffTable
              files={parsed.logs}
              hint="trace artifacts accumulated across the group"
            />
          )}
          {parsed.logs.length === 0 && parsed.other.length === 0 && (
            <L mono size={11} color={WF.ink3}>no net file changes across the group</L>
          )}
        </div>
      )}
    </Box>
  );
}

// Change-by-change view of an edit_sequence group, regrouped by file. Rather
// than one box per commit, the group's edits are bucketed by the file they
// touch: a section per file, and within it that file's own edits in
// chronological order with a downward arrow between consecutive ones — so a
// single file's progression reads top to bottom, edit by edit, before the next
// file begins. For an image edited repeatedly this section becomes a filmstrip
// of stacked before→after pairs. Every member's `git show` is fetched once and
// parseDiff splits it into per-file patches that get bucketed by path.
function StepwiseSequencePanel({ group, onSelectCommit }) {
  const { selectedInput } = useData();
  const members = group.members || [];
  const shaKey = members.map((m) => m.sha).join(',');
  // sha → { status, parsed, error } for each member commit's full diff.
  const [diffs, setDiffs] = React.useState({});

  React.useEffect(() => {
    let alive = true;
    setDiffs({});
    (async () => {
      await Promise.all(members.map(async (m) => {
        try {
          const r = await fetch(`/api/diff?sha=${encodeURIComponent(m.sha)}${nameParam(selectedInput)}`);
          const text = await r.text();
          if (!r.ok) throw new Error(text || `HTTP ${r.status}`);
          const parsed = parseDiff(text);
          if (alive) setDiffs((d) => ({ ...d, [m.sha]: { status: 'ready', parsed, error: null } }));
        } catch (err) {
          if (alive) setDiffs((d) => ({ ...d, [m.sha]: { status: 'error', parsed: null, error: err.message } }));
        }
      }));
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shaKey, selectedInput]);

  // Walk the members in chronological order, bucketing each source-file patch by
  // path so every bucket's edits read oldest → newest. Files are listed in the
  // order they were first touched in the sequence. Log artifacts are pulled out
  // here and walled off at the bottom (see `logsByMember` / SequenceLogSection),
  // matching the single-commit view and the semantic-areas progression: logs are
  // append-heavy trace output, not auditable source, so they get the compact
  // changed-lines-only table rather than the full per-file diff treatment.
  const fileProgressions = React.useMemo(() => {
    const map = new Map();
    const order = [];
    for (const m of members) {
      const entry = diffs[m.sha];
      if (!entry || entry.status !== 'ready') continue;
      for (const file of entry.parsed.other) {
        if (!map.has(file.path)) { map.set(file.path, []); order.push(file.path); }
        map.get(file.path).push({ member: m, file });
      }
    }
    return order.map((path) => ({ path, edits: map.get(path) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shaKey, diffs]);

  // Logs grouped by commit (one table per member that touched a log), in the
  // same chronological order as the source progression above.
  const logsByMember = React.useMemo(() => {
    const out = [];
    for (const m of members) {
      const entry = diffs[m.sha];
      if (!entry || entry.status !== 'ready' || entry.parsed.logs.length === 0) continue;
      out.push({ member: m, logs: entry.parsed.logs });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shaKey, diffs]);

  const readyCount = members.filter((m) => diffs[m.sha]?.status === 'ready').length;
  const errors = members.filter((m) => diffs[m.sha]?.status === 'error');
  const allReady = readyCount === members.length;

  return (
    <Box style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <L size={13} weight={700}>change-by-change</L>
        <Chip>{fileProgressions.length} file{fileProgressions.length === 1 ? '' : 's'}</Chip>
        <L mono size={10} color={WF.ink3}>· each file's own edits, oldest → newest</L>
        {!allReady && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <L mono size={10} color={WF.ink3}>· loading {readyCount}/{members.length} commits</L>
            <Dots size={4} />
          </span>
        )}
      </div>
      {errors.length > 0 && (
        <L mono size={11} color={WF.heat4} style={{ display: 'block', marginTop: 8 }}>
          couldn't load {errors.length} commit{errors.length === 1 ? '' : 's'} ({errors[0].sha?.slice(0, 7)}: {diffs[errors[0].sha]?.error})
        </L>
      )}
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 22 }}>
        {fileProgressions.map((fp) => (
          <FileProgression key={fp.path} fp={fp} onSelectCommit={onSelectCommit} />
        ))}
        {allReady && fileProgressions.length === 0 && logsByMember.length === 0 && (
          <L mono size={11} color={WF.ink3}>no file changes across the sequence</L>
        )}
        {allReady && fileProgressions.length === 0 && logsByMember.length > 0 && (
          <L mono size={11} color={WF.ink3}>no source-file changes — log artifacts only</L>
        )}
      </div>

      {/* Logs walled off below the source progression: append-heavy trace
          artifacts, grouped by commit, changed lines only — same treatment as
          the single-commit view's LogDiffTable and the semantic-areas page. */}
      {logsByMember.length > 0 && (
        <div style={{ marginTop: 24, borderTop: `2px solid ${WF.ink2}`, paddingTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ width: 12, height: 12, background: WF.ink2, border: inkBorder() }} />
            <L size={13} weight={700}>log artifacts</L>
            <Chip>{logsByMember.length}</Chip>
            <L mono size={10} color={WF.ink3}>· trace output — grouped by commit, changed lines only</L>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {logsByMember.map(({ member, logs }) => (
              <SequenceLogCommit key={member.id} member={member} logs={logs} onSelectCommit={onSelectCommit} />
            ))}
          </div>
        </div>
      )}
    </Box>
  );
}

// One member commit's log artifacts inside the sequence's log section: a
// clickable commit strip over a table whose rows are that commit's log files,
// each showing only its changed (+/−) lines. Mirrors the source FileEditStep's
// header so the two sections read consistently, but reuses the compact LogDiffRow
// rather than the full FileDiff treatment.
function SequenceLogCommit({ member, logs, onSelectCommit }) {
  const mark = memberFlagMark(member);
  const border = `1px solid ${WF.rule}`;
  return (
    <Box style={{ padding: 0, overflow: 'hidden' }}>
      <div
        onClick={() => onSelectCommit && onSelectCommit(member.id)}
        title={mark ? `open this commit · ${mark.label}` : 'open this individual commit'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          background: mark ? WF.mark : WF.paperAlt,
          borderBottom: inkBorder(),
          cursor: 'pointer',
          boxShadow: mark ? `inset 3px 0 0 ${mark.accent}` : undefined,
          flexWrap: 'wrap',
        }}
      >
        <Sha sha={member.sha} size={12} weight={700} />
        <L
          size={12}
          color={WF.ink2}
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >{member.title || '(untitled)'}</L>
        {mark && (
          <Chip style={{ background: mark.bg, color: mark.fg, borderColor: mark.bg }} title={mark.label}>{mark.label}</Chip>
        )}
        <L mono size={10} color={WF.ink3}>{logs.length} log file{logs.length === 1 ? '' : 's'}</L>
        <Stamp size={10} color={WF.ink3}>{fmtClock(member.t)}</Stamp>
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: '32%' }} />
          <col style={{ width: '68%' }} />
        </colgroup>
        <tbody>
          {logs.map((file, i) => (
            <LogDiffRow key={file.path + ':' + i} file={file} first={i === 0} border={border} />
          ))}
        </tbody>
      </table>
    </Box>
  );
}

// One file's section in StepwiseSequencePanel: a header naming the file, then
// every commit that touched it rendered in chronological order with a downward
// arrow between consecutive edits.
function FileProgression({ fp, onSelectCommit }) {
  // The header path is a quick shortcut to the first edit's standalone dossier
  // view — the per-edit strips below already deep-link each individual commit,
  // so this just gives the file's chain a one-click "jump to start" affordance.
  const firstId = fp.edits[0]?.member?.id || null;
  const headerClickable = !!firstId && !!onSelectCommit;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ width: 12, height: 12, background: WF.ink, border: inkBorder() }} />
        <span
          onClick={headerClickable ? () => onSelectCommit(firstId) : undefined}
          title={headerClickable ? 'open the first commit in this file’s chain' : undefined}
          style={headerClickable ? { cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 2 } : undefined}
        >
          <L mono size={12} weight={700} style={{ wordBreak: 'break-all' }}>{fp.path}</L>
        </span>
        <Chip>{fp.edits.length} edit{fp.edits.length === 1 ? '' : 's'}</Chip>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {fp.edits.map(({ member, file }, i) => (
          <React.Fragment key={member.id + ':' + i}>
            <FileEditStep member={member} file={file} index={i} total={fp.edits.length} onSelectCommit={onSelectCommit} />
            {i < fp.edits.length - 1 && <DownArrow />}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// One edit within a file's progression: a clickable commit strip (which commit,
// its ±counts and badges, flag, time) over that commit's patch for this one
// file. The strip carries the per-edit detail so the body renders bare (no
// repeated path header). Reuses FileDiff (hideHeader) so images show
// before→after, big bodies keep the preview/expand guard, and source diffs keep
// the directional context controls.
function FileEditStep({ member, file, index, total, onSelectCommit }) {
  const mark = memberFlagMark(member);
  const adds = file.body.filter((l) => /^\+[^+]/.test(l)).length;
  const dels = file.body.filter((l) => /^-[^-]/.test(l)).length;
  const isImage = IMAGE_EXT_RE.test(file.path);
  const isNew = file.meta.some((l) => /^new file mode/.test(l));
  const isDeleted = file.meta.some((l) => /^deleted file mode/.test(l));
  return (
    <Box style={{ padding: 0, overflow: 'hidden' }}>
      <div
        onClick={() => onSelectCommit && onSelectCommit(member.id)}
        title={mark ? `open this commit · ${mark.label}` : 'open this individual commit'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          background: mark ? WF.mark : WF.paperAlt,
          borderBottom: `1px solid ${WF.rule}`,
          cursor: 'pointer',
          boxShadow: mark ? `inset 3px 0 0 ${mark.accent}` : undefined,
          flexWrap: 'wrap',
        }}
      >
        <L mono size={10} color={WF.ink3}>edit {index + 1}/{total}</L>
        <Sha sha={member.sha} size={12} weight={700} />
        <L
          size={12}
          color={WF.ink2}
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >{member.title || '(untitled)'}</L>
        {!isImage && adds > 0 && <L mono size={11} color={WF.tagGreenFg}>+{adds}</L>}
        {!isImage && dels > 0 && <L mono size={11} color={WF.heat4}>−{dels}</L>}
        {isImage && <Chip>image</Chip>}
        {isNew && <Chip>new file</Chip>}
        {isDeleted && <Chip>deleted</Chip>}
        {mark && (
          <Chip style={{ background: mark.bg, color: mark.fg, borderColor: mark.bg }} title={mark.label}>{mark.label}</Chip>
        )}
        <Stamp size={10} color={WF.ink3}>{fmtClock(member.t)}</Stamp>
      </div>
      <FileDiff file={file} sha={member.sha} hideHeader />
    </Box>
  );
}

function DossierBody({ chunk, byId, checkedOut, pendingCheckout, checkoutEnabled, onCheckout, onNavigate }) {
  const { toggleDismiss, toggleFlag } = useData();
  const style = KIND_STYLE[chunk.kind] || KIND_STYLE.SYNC;
  const bigChip = { fontSize: 16, padding: '6px 12px', borderRadius: 3 };
  // One commit-diff fetch shared by the git-diff box and the bash "output" box.
  const diff = useCommitDiff(chunk.sha);
  // For user-shell commands, the pane log the command wrote is surfaced as its
  // own "output" diff; resolve its path from the same parse so the output box
  // and the git-diff box's "see above" point at the same file.
  const paneFile = chunk.source === 'commands'
    ? findPaneFile(diff.parsed, chunk.bashContext?.session)
    : null;
  const panePath = paneFile?.path || null;
  // Bash events (user-typed `source:'commands'` and Claude `Bash` tool calls)
  // get the command box full-width rather than tiled half-width — see below.
  const isBash = chunk.kind === 'BASH';

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'auto' }}>
      <div style={{ padding: 14, borderBottom: inkBorder() }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Chip style={{ ...bigChip, background: style.bg, color: style.fg, borderColor: style.fg }}>
                {style.glyph} {(chunk.kindLabel || chunk.kind).toLowerCase()}
              </Chip>
              <Sha sha={chunk.sha} len={12} size={14} weight={700} />
              <L mono size={12} color={WF.ink2}><Stamp inline>{fmtFullClock(chunk.t)} · </Stamp>{chunk.source}</L>
            </div>
            <CopyTitle
              size={16}
              style={{ marginTop: 10 }}
              copyText={refStatement({ kind: 'commit', label: chunk.title || chunk.file || '(untitled)', idField: 'event_id', id: chunk.id, shas: chunk.sha ? [chunk.sha] : [] })}
            >{chunk.title || '(untitled)'}</CopyTitle>
            {chunk.summary && (
              <L size={13} color={WF.ink2} style={{ display: 'block', marginTop: 4 }}>{chunk.summary}</L>
            )}
          </div>
          {/* Flag + tag this commit, kept by the git-checkout action with the tag
              editor stacked right under the flag so tagging is always one click
              away (adding a tag flags the commit). */}
          <FlagTagColumn
            flagged={chunk.userFlagged}
            label={chunk.userFlagged ? '[!] flagged' : '[ ] flag'}
            title={chunk.userFlagged ? 'remove your flag' : 'flag for review'}
            onToggle={() => toggleFlag(chunk.id)}
            targetKey={chunk.id}
            noun="commit"
            lead={chunk.sha && (
              checkedOut ? (
                <Chip style={{ ...bigChip, background: WF.ink, color: WF.paper, borderColor: WF.ink }}>✓ HEAD</Chip>
              ) : pendingCheckout ? (
                <Chip style={{ ...bigChip, background: WF.heat3, color: WF.onAccent, borderColor: WF.heat3, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  checking out <Dots size={5} color={WF.onAccent} />
                </Chip>
              ) : (
                <Chip
                  style={{ ...bigChip, cursor: checkoutEnabled ? 'pointer' : 'not-allowed', opacity: checkoutEnabled ? 1 : 0.5 }}
                  bg="transparent"
                  color={WF.ink}
                  onClick={checkoutEnabled ? onCheckout : undefined}
                  title={checkoutEnabled ? `git checkout ${chunk.sha.slice(0, 7)} in the reconstruction repo` : 'checkout disabled in production build'}
                >
                  ↺ git checkout
                </Chip>
              )
            )}
          />
        </div>
      </div>

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* The context panels — what's being done, any semantic-thread
            membership, and the raw audit event (or, for Bash, the lightweight
            session/cwd context) — tile two-per-row (odd one full width).
            Annotations and threads lead so that when both are present they read
            side by side ("what's being done" next to the thread it advances);
            the audit event / shell context then falls to the next row after the
            two. Bash events are the exception for the command itself: that box
            goes full-width below (a command + its pane output read badly
            squeezed into a half-width tile), so only the lightweight session/cwd
            context tiles up here. */}
        <Tiles>
          {(chunk.annotations || []).length > 0 && <AnnotationsPanel annotations={chunk.annotations} />}
          {(chunk.threads || []).length > 0 && <ThreadsPanel threads={chunk.threads} />}
          {isBash
            ? (chunk.bashContext && (
                <Box style={{ padding: 10 }}>
                  <L size={12} weight={600}>shell context</L>
                  <KV k="session"        v={chunk.bashContext.session} />
                  <KV k="cwd"            v={chunk.bashContext.cwd} />
                  <KV k="pane log lines" v={String(chunk.bashContext.pane_log_lines ?? 0)} />
                </Box>
              ))
            : <RawLineDetail chunk={chunk} />}
        </Tiles>

        {(chunk.suspicions || []).length > 0 && (
          <SuspicionsPanel
            suspicions={chunk.suspicions}
            agg={chunk.suspicionAgg}
            byId={byId}
            currentId={chunk.id}
            onNavigate={onNavigate}
            dismissed={!!chunk.suspicionDismissed}
            onDismiss={() => toggleDismiss(chunk.id)}
          />
        )}

        {(chunk.flags || []).length > 0 && (
          <Box style={{ padding: 10, borderColor: WF.rule2, background: WF.paperAlt }}>
            <L size={12} weight={700} color={WF.ink2}>ⓘ heuristic note</L>
            <L size={11} color={WF.ink3} style={{ display: 'block', marginTop: 2 }}>
              Deterministic signal, not a verdict — a results file was produced by a run here and later deleted. This is common in normal iteration (re-run, cleanup) and can also be an artifact of the logging process. Worth a glance, not an alarm.
            </L>
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {chunk.flags.map((f, i) => (
                <FlagDetail key={i} flag={f} byId={byId} onNavigate={onNavigate} />
              ))}
            </div>
          </Box>
        )}

        {/* The shell command itself spans full width, grouped with its output
            below — a command and its pane log read badly half-width. The shell
            context for these tiles up beside "what's being done" instead. */}
        {isBash && <RawLineDetail chunk={chunk} />}

        {/* User-shell commands capture their terminal output in the pane log;
            surface it as a first-class "output" block — the pane file's git diff
            (green/red), between the shell context and git diff boxes. The git
            diff box's log table then defers to this with a "see above". */}
        {panePath && <PaneOutputBox diff={diff} panePath={panePath} />}

        {chunk.sha && <DiffPanel sha={chunk.sha} diff={diff} panePath={panePath} />}
      </div>
    </div>
  );
}

// Thin right rail: the full history+future of the file the selected commit
// touches, rendered as a vertical chain (linked-list spine of dots) of every
// commit that edited / created / deleted that path. The selected commit is
// highlighted in place; everything above it is earlier, everything below is
// later. Clicking a node whose commit has a matching event jumps there.
const FILELOG_STATUS = {
  A: { glyph: '+', color: WF.tagGreenFg, label: 'added' },
  M: { glyph: '~', color: WF.tagAmberFg, label: 'modified' },
  D: { glyph: '−', color: WF.heat4,  label: 'deleted' },
  R: { glyph: '→', color: WF.tagBlueFg, label: 'renamed' },
  C: { glyph: '⎘', color: WF.tagBlueFg, label: 'copied' },
};

function FileTimeline({ chunk, byId, onNavigate, width = 256 }) {
  const { selectedInput } = useData();
  const { paneWidths, setPaneWidth, inboxTitleFromShortTitle } = useSettings();
  const file = chunk.file;
  // The validator-notes box shares this column with the commit list below the
  // header. `sharedRef` wraps both so the resizer can clamp the notes height to
  // 60% of that shared space, measured live at drag time; a matching CSS
  // maxHeight backstops it for short viewports / a stale stored value.
  const sharedRef = React.useRef(null);
  const notesMax = () => (sharedRef.current ? Math.round(sharedRef.current.clientHeight * 0.6) : Infinity);
  // The log content is identical for every commit of the same file — only the
  // "you are here" marker moves — so key the fetch on `file` alone and read
  // the resolving sha from a ref to avoid a refetch (and flash) when
  // navigating between commits of the same file.
  const shaRef = React.useRef(chunk.sha);
  shaRef.current = chunk.sha;
  const [state, setState] = React.useState({ status: 'idle', entries: [], error: null });

  React.useEffect(() => {
    if (!file) { setState({ status: 'idle', entries: [], error: null }); return; }
    let cancelled = false;
    setState({ status: 'loading', entries: [], error: null });
    (async () => {
      try {
        const q = `/api/filelog?sha=${encodeURIComponent(shaRef.current)}&path=${encodeURIComponent(file)}${nameParam(selectedInput)}`;
        const r = await fetch(q);
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        // git emits newest-first; flip so the chain reads past → future top
        // to bottom.
        setState({ status: 'ready', entries: (j.entries || []).slice().reverse(), error: null });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', entries: [], error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, [file, selectedInput]);

  // sha → event id, so a node can navigate the inbox to the matching commit.
  const idBySha = React.useMemo(() => {
    const m = {};
    for (const c of Object.values(byId)) { if (c.sha && !(c.sha in m)) m[c.sha] = c.id; }
    return m;
  }, [byId]);

  const currentIdx = state.entries.findIndex((e) => e.sha === chunk.sha);

  return (
    <div style={{ width, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: WF.paper }}>
      <div style={{ padding: '10px 12px', borderBottom: inkBorder() }}>
        <L size={13} weight={700}>file timeline</L>
        {file ? (
          <div title={file} style={{ marginTop: 4 }}>
            <L mono size={11} color={WF.ink2} style={{ display: 'block', overflowWrap: 'anywhere' }}>
              {basename(file)}
            </L>
            {state.status === 'ready' && (
              <L mono size={10} color={WF.ink3} style={{ display: 'block', marginTop: 2 }}>
                {state.entries.length} commit{state.entries.length === 1 ? '' : 's'} · {currentIdx >= 0 ? `#${currentIdx + 1} of ${state.entries.length}` : 'this commit not in chain'}
              </L>
            )}
          </div>
        ) : (
          <L mono size={10} color={WF.ink3} style={{ display: 'block', marginTop: 4 }}>
            no file on this commit
          </L>
        )}
      </div>
      {/* The commit list and the validator-notes box share the space under the
          header; a vertical resizer between them lets the auditor trade list
          height for note-taking room. */}
      <div ref={sharedRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 0' }}>
          {!file && <TimelineEmpty text="this event doesn't touch a tracked file (bash / session / sync)" />}
          {file && state.status === 'loading' && <LoadingBox label="loading file history" height={64} style={{ margin: '8px 0' }} />}
          {file && state.status === 'error' && <TimelineEmpty text={`error: ${state.error}`} tone="error" />}
          {file && state.status === 'ready' && state.entries.length === 0 && (
            <TimelineEmpty text="no commits found for this path" />
          )}
          {file && state.status === 'ready' && state.entries.map((e, i) => {
            // Commits between this file-edit and the previous one shown = the
            // distance in the full repo history minus this hop (ord: 0 = newest).
            const prev = i > 0 ? state.entries[i - 1] : null;
            const gap = prev && prev.ord != null && e.ord != null
              ? Math.abs(prev.ord - e.ord) - 1
              : null;
            // The annotation headline lives on the matching event, reachable via
            // the same sha → id → chunk hop the jump-to navigation uses; '' when
            // the commit has no event record or no annotation.
            const shortTitle = byId[idBySha[e.sha]]?.shortTitle || '';
            return (
              <React.Fragment key={e.sha + ':' + i}>
                {gap > 0 && <SpineGap n={gap} />}
                <TimelineNode
                  entry={e}
                  shortTitle={shortTitle}
                  titleFromShortTitle={inboxTitleFromShortTitle}
                  isCurrent={e.sha === chunk.sha}
                  isFirst={i === 0}
                  isLast={i === state.entries.length - 1}
                  targetId={idBySha[e.sha]}
                  onNavigate={onNavigate}
                />
              </React.Fragment>
            );
          })}
        </div>
        {/* Handle sits on the notes box's top (leading) edge, so dragging up
            grows the notes → dir = -1. The resizer draws its own divider line,
            so the notes box below carries no top border. */}
        <PaneResizer
          axis="y"
          dir={-1}
          width={paneWidths.dossierNotes}
          setWidth={(h) => setPaneWidth('dossierNotes', h)}
          min={88}
          max={notesMax}
          dflt={PANE_DEFAULTS.dossierNotes}
        />
        {/* Validator notes share this rail, anchored below the file timeline so
            the auditor's annotations sit alongside the file's history rather than
            buried at the bottom of the dossier scroll. */}
        <div style={{ flex: 'none', height: paneWidths.dossierNotes, maxHeight: '60%', padding: '10px 12px', overflow: 'auto', background: WF.paper }}>
          <L size={12} weight={600}>validator notes (you)</L>
          <div style={{ marginTop: 8 }}>
            <ValidatorNotesEditor chunkId={chunk.id} notes={chunk.userNotes} />
          </div>
        </div>
      </div>
    </div>
  );
}

function TimelineNode({ entry, shortTitle, titleFromShortTitle, isCurrent, isFirst, isLast, targetId, onNavigate }) {
  const st = FILELOG_STATUS[entry.status] || { glyph: '·', color: WF.ink3, label: entry.status || 'touched' };
  const clickable = !!targetId && !isCurrent;
  const orphan = !targetId && !isCurrent; // commit touched the file but has no event record
  // Mirror the inbox's "title from short title" setting: lead with the
  // annotation headline when it's on and one exists, else the raw git subject.
  // The hover title always carries the underlying commit message so the real
  // subject stays discoverable even while the headline is shown.
  const useShort = titleFromShortTitle && shortTitle;
  const label = useShort ? shortTitle : (entry.subject || '(no message)');
  return (
    <div
      onClick={clickable ? () => onNavigate(targetId) : undefined}
      title={
        isCurrent ? 'current commit'
          : clickable ? `jump to ${entry.sha.slice(0, 7)} · ${st.label}`
          : 'no event record for this commit (e.g. skeleton / sync)'
      }
      style={{
        display: 'grid',
        gridTemplateColumns: '22px 1fr',
        gap: 8,
        padding: '3px 12px 3px 6px',
        cursor: clickable ? 'pointer' : 'default',
        background: isCurrent ? WF.paperAlt : 'transparent',
        boxShadow: isCurrent ? `inset 3px 0 0 ${WF.ink}` : undefined,
        opacity: orphan ? 0.5 : 1,
      }}
    >
      <div style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
        {/* spine: trimmed to a half-segment at the ends so the chain reads as
            terminating at the first/last node */}
        <div style={{ position: 'absolute', top: isFirst ? 11 : 0, bottom: isLast ? 'calc(100% - 11px)' : 0, width: 2, background: WF.rule2 }} />
        <div
          style={{
            position: 'relative',
            marginTop: 4,
            width: 13,
            height: 13,
            borderRadius: '50%',
            background: isCurrent ? st.color : WF.paper,
            border: `2px solid ${st.color}`,
            boxShadow: isCurrent ? `0 0 0 3px ${WF.paperAlt}` : undefined,
          }}
        />
      </div>
      <div style={{ minWidth: 0, paddingBottom: 4 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <L mono size={11} weight={700} color={st.color}>{st.glyph}</L>
          <Sha sha={entry.sha} size={10} color={WF.ink3} />
          <div style={{ flex: 1 }} />
          <Stamp size={9} color={WF.ink3}>{fmtShortDate(entry.date)}</Stamp>
        </div>
        <div
          title={useShort ? `${shortTitle}\n${entry.subject || '(no message)'}` : entry.subject}
          style={{
            marginTop: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <L size={11} color={isCurrent ? WF.ink : WF.ink2} weight={isCurrent ? 700 : 400}>
            {label}
          </L>
        </div>
        {entry.from && (
          <div title={entry.from} style={{ marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <L mono size={9} color={WF.ink3}>↳ renamed from {basename(entry.from)}</L>
          </div>
        )}
      </div>
    </div>
  );
}

// A break in the chain: commits that landed between two consecutive edits of
// this file but didn't touch it. Drawn as a dotted spine segment so the gap
// reads as elapsed history rather than adjacency.
function SpineGap({ n }) {
  return (
    <div
      title={`${n} commit${n === 1 ? '' : 's'} elsewhere between these two edits`}
      style={{ display: 'grid', gridTemplateColumns: '22px 1fr', gap: 8, padding: '2px 12px 2px 6px' }}
    >
      <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', minHeight: 18 }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: 2,
            backgroundImage: `repeating-linear-gradient(${WF.rule2} 0 2px, transparent 2px 5px)`,
          }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', minHeight: 18 }}>
        <L mono size={9} color={WF.ink3}>⋯ {n} commit{n === 1 ? '' : 's'} between</L>
      </div>
    </div>
  );
}

function TimelineEmpty({ text, tone }) {
  return (
    <div style={{ padding: '16px 14px', textAlign: 'center' }}>
      <L mono size={11} color={tone === 'error' ? WF.heat4 : WF.ink3}>{text}</L>
    </div>
  );
}

function basename(p) {
  if (!p) return '';
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

// Resolve a (possibly abbreviated) commit SHA to its chunk. Chunk `.sha` is the
// full inner_commit_sha, but artifact fields like a suspicion's evidence_commits
// often carry abbreviated SHAs (e.g. 0022146d1b52) — an exact `c.sha === sha`
// match misses those, which is why such commits showed up unclickable. Mirror
// makeShaResolver: exact first, then a prefix match in either direction.
function findCommitBySha(byId, sha) {
  if (!sha) return null;
  const rows = Object.values(byId);
  return (
    rows.find((c) => c.sha === sha) ||
    rows.find((c) => c.sha && (c.sha.startsWith(sha) || sha.startsWith(c.sha))) ||
    null
  );
}

function fmtShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function SuspicionsPanel({ suspicions, agg, byId, currentId, onNavigate, dismissed, onDismiss }) {
  const max = agg?.flag_level_max || suspicions[0]?.flag_level || 'low';
  const style = LEVEL_STYLE[max] || LEVEL_STYLE.low;
  // Dismissed reads as cleared: drop the panel's red border for a muted ink one,
  // soften the background to neutral paper, and fade — so the wording stays
  // readable but the warning prominence goes away.
  const borderColor = dismissed ? WF.rule2 : style.bg;
  const background = dismissed ? WF.paperAlt : WF.tint;
  return (
    <Box style={{ padding: 12, borderColor, background, borderWidth: 2, opacity: dismissed ? 0.78 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Chip style={{ background: dismissed ? WF.heat2 : style.bg, color: style.fg, borderColor: dismissed ? WF.heat2 : style.bg, fontSize: 13, padding: '3px 8px' }}>
          {style.label} suspicion
        </Chip>
        {agg?.agreement_count > 1 && <Chip>{agg.agreement_count} agents agree</Chip>}
        {agg?.category_mode && <Chip>{agg.category_mode}</Chip>}
        {dismissed && <Chip bg={WF.paperAlt} color={WF.ink2}>dismissed</Chip>}
        <div style={{ flex: 1 }} />
        {onDismiss && (
          <Chip
            onClick={onDismiss}
            style={{ cursor: 'pointer', background: dismissed ? WF.paper : WF.paperAlt, color: WF.ink2 }}
            title={dismissed
              ? 'restore this suspicion — also visible from overview and the semantic-areas screen'
              : 'dismiss: I looked, this is fine — clears it from the overview list and semantic-areas screen too'}
          >{dismissed ? '↩ restore' : '✕ dismiss'}</Chip>
        )}
      </div>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {suspicions.map((s, i) => (
          <SuspicionDetail key={s.suspicion_id || i} s={s} byId={byId} currentId={currentId} onNavigate={onNavigate} dimmed={dismissed} />
        ))}
      </div>
    </Box>
  );
}

export function SuspicionDetail({ s, byId, currentId, onNavigate, dimmed }) {
  const lvl = LEVEL_STYLE[s.flag_level] || LEVEL_STYLE.low;
  // When the surrounding suspicion is dismissed, drop the entry's red border
  // accent to a muted heat — same content, demoted prominence.
  const accent = dimmed ? WF.heat2 : lvl.bg;
  return (
    <div style={{ borderLeft: `4px solid ${accent}`, paddingLeft: 10 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip style={{ background: accent, color: lvl.fg, borderColor: accent }}>{lvl.label}</Chip>
        {s.category && <Chip>{s.category}</Chip>}
        {s.intent_hypothesis && s.intent_hypothesis !== 'unclear' && (
          <Chip>intent: {s.intent_hypothesis}</Chip>
        )}
      </div>
      {s.commit_commentary && (
        <div style={{ marginTop: 6 }}>
          <L size={11} weight={700} color={WF.ink2}>what happened</L>
          <L size={12} style={{ display: 'block', marginTop: 2, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
            {renderInline(s.commit_commentary)}
          </L>
        </div>
      )}
      {s.suspicion_reasoning && (
        <div style={{ marginTop: 6 }}>
          <L size={11} weight={700} color={WF.ink2}>why it might matter</L>
          <L size={12} color={WF.ink2} style={{ display: 'block', marginTop: 2, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
            {renderInline(s.suspicion_reasoning)}
          </L>
        </div>
      )}
      {(s.evidence_commits || []).length > 1 && (
        <div style={{ marginTop: 8 }}>
          <L size={11} weight={700} color={WF.ink2}>evidence commits</L>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {s.evidence_commits.map((sha) => {
              const row = findCommitBySha(byId, sha);
              // Always show the short hash here — these chips are commit-to-commit
              // connections, so the hash is the identifier even when the global
              // "show commit hashes" setting is off (otherwise they all read
              // "commit" and become indistinguishable).
              const short = (row?.sha || sha).slice(0, 7);
              // The commit already open in the dossier shows up in its own
              // evidence list; navigating to it is a no-op (looks like a dead
              // click), so mark it "(current)" and drop the arrow / click target.
              const isCurrent = row && currentId != null && row.id === currentId;
              return (
                <Chip
                  key={sha}
                  style={{ cursor: row && !isCurrent ? 'pointer' : 'default' }}
                  onClick={() => row && !isCurrent && onNavigate(row.id)}
                  title={isCurrent ? 'the commit you’re viewing' : (row ? row.title : 'unmatched commit')}
                >{short}{isCurrent ? ' (current)' : (row ? ' →' : '')}</Chip>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Descriptive annotations from the annotation_agent fleet — "what is being
// done", as opposed to the suspicion fleet's "what might be wrong". Calm,
// neutral styling so they read as narration, not alarm.
const ACTIVITY_STYLE = {
  training:   { bg: WF.tagBlueBg,   fg: WF.tagBlueFg },
  evaluation: { bg: WF.tagBlueBg,   fg: WF.tagBlueFg },
  data_prep:  { bg: WF.tagGreenBg,  fg: WF.tagGreenFg },
  analysis:   { bg: WF.tagPurpleBg, fg: WF.tagPurpleFg },
  plotting:   { bg: WF.tagAmberBg,  fg: WF.tagAmberFg },
  config:     { bg: WF.tagSlateBg,  fg: WF.tagSlateFg },
  refactor:   { bg: WF.tagSlateBg,  fg: WF.tagSlateFg },
  cleanup:    { bg: WF.tagSlateBg,  fg: WF.tagSlateFg },
  debugging:  { bg: WF.tagRedBg,    fg: WF.tagRedFg },
  setup:      { bg: WF.tagSlateBg,  fg: WF.tagSlateFg },
  other:      { bg: WF.paperAlt, fg: WF.ink2 },
};
const activityStyle = (a) => ACTIVITY_STYLE[a] || ACTIVITY_STYLE.other;

// One annotation line: an activity chip, an optional source label (a member
// SHA, "whole group", or agent id), and the description. Clickable when it
// points at a specific commit.
function AnnotationItem({ a, sourceLabel, onClick }) {
  const st = activityStyle(a.activity);
  return (
    <div
      onClick={onClick}
      title={onClick ? 'open this commit' : undefined}
      style={{ borderLeft: `3px solid ${st.fg}`, paddingLeft: 8, cursor: onClick ? 'pointer' : 'default' }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {a.activity && (
          <Chip style={{ background: st.bg, color: st.fg, borderColor: st.fg }}>{a.activity}</Chip>
        )}
        {sourceLabel && (
          <L mono size={10} color={WF.ink3}>{sourceLabel}{onClick ? ' →' : ''}</L>
        )}
      </div>
      <L size={12} style={{ display: 'block', marginTop: 2, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
        {renderInline(a.annotation)}
      </L>
    </div>
  );
}

// Commit dossier: the descriptions attached to this one commit.
function AnnotationsPanel({ annotations, style }) {
  if (!annotations || annotations.length === 0) return null;
  return (
    <Box style={{ padding: 10, borderColor: WF.ink3, background: WF.panel, ...style }}>
      <L size={12} weight={700} color={WF.ink2}>📝 what's being done</L>
      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {annotations.map((a, i) => (
          <AnnotationItem key={a.annotation_id || i} a={a} sourceLabel={a.agent_id} />
        ))}
      </div>
    </Box>
  );
}

// Commit dossier: which semantic thread(s) this commit belongs to. Denotes the
// association (the thread_agent's line of work) and, when present, this commit's
// beat-note within the thread. The full thread progression lives on the
// semantic-areas screen.
function ThreadsPanel({ threads, style }) {
  const { openThread } = useData();
  if (!threads || threads.length === 0) return null;
  return (
    <Box style={{ padding: 10, borderColor: WF.ink2, background: WF.panel, ...style }}>
      <L size={12} weight={700} color={WF.ink2}>
        🧵 part of {threads.length === 1 ? 'a semantic thread' : `${threads.length} semantic threads`}
      </L>
      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {threads.map((t, i) => {
          const linkable = !!t.thread_id;
          return (
            <button
              key={t.thread_id || i}
              type="button"
              onClick={linkable ? () => openThread(t.thread_id) : undefined}
              title={linkable ? 'open this thread on the semantic-areas screen' : undefined}
              style={{
                appearance: 'none', font: 'inherit', textAlign: 'left', width: '100%',
                border: 'none', background: 'transparent', padding: '2px 0 2px 8px',
                borderLeft: `3px solid ${WF.ink2}`, cursor: linkable ? 'pointer' : 'default',
              }}
            >
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <L
                  size={12}
                  weight={600}
                  style={linkable ? { textDecoration: 'underline', textDecorationColor: WF.ink3 } : undefined}
                >
                  {t.label}
                </L>
                {t.theme && <Chip>{t.theme}</Chip>}
                {linkable && <L size={11} color={WF.ink3}>↗</L>}
              </div>
              {t.note && (
                <L size={12} color={WF.ink2} style={{ display: 'block', marginTop: 2, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                  {renderInline(t.note)}
                </L>
              )}
            </button>
          );
        })}
      </div>
      <L mono size={10} color={WF.ink3} style={{ display: 'block', marginTop: 6 }}>
        click to view thread
      </L>
    </Box>
  );
}

// Auditor's own validator notes attached to the whole group (not any one
// member). Persists under a `group:<id>` overlay key so it round-trips through
// the same flag/note storage as commits and semantic areas. The left accent
// turns red when the auditor has also group-flagged it, so the box visibly
// echoes the dossier-header verdict.
function GroupValidatorNotes({ flagKey, notes, flagged, style }) {
  return (
    <Box
      style={{
        padding: 10,
        borderColor: WF.ink3,
        borderLeft: `5px solid ${flagged ? WF.heat4 : WF.ink}`,
        background: WF.paper,
        ...style,
      }}
    >
      <L size={12} weight={700} color={WF.ink2}>validator notes (you) · whole group</L>
      <div style={{ marginTop: 8 }}>
        <ValidatorNotesEditor
          chunkId={flagKey}
          notes={notes}
          placeholder="add a validator note on this group …"
        />
      </div>
    </Box>
  );
}

// Group dossier: pull the group-level annotation AND every member commit's
// annotation into the group report, each tagged with which commit it came
// from (flagged members get a 🚩). Clicking a member annotation opens it.
function GroupAnnotations({ group, onSelectCommit, style }) {
  const { data } = useData();
  const { showCommitHashes } = useSettings();
  const groupAnnos = (data?.annotationsByGroup && data.annotationsByGroup[group.id]) || [];
  const memberAnnos = [];
  for (const m of group.members || []) {
    for (const a of (m.annotations || [])) memberAnnos.push({ a, member: m });
  }
  if (groupAnnos.length === 0 && memberAnnos.length === 0) return null;
  return (
    <Box style={{ padding: 10, borderColor: WF.ink3, background: WF.panel, ...style }}>
      <L size={12} weight={700} color={WF.ink2}>📝 annotations in this group</L>
      {groupAnnos.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {groupAnnos.map((a, i) => (
            <AnnotationItem key={a.annotation_id || i} a={a} sourceLabel="whole group" />
          ))}
        </div>
      )}
      {memberAnnos.length > 0 && (
        <div style={{ marginTop: groupAnnos.length ? 10 : 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <L mono size={10} color={WF.ink3}>from member commits</L>
          {memberAnnos.map(({ a, member }, i) => (
            <AnnotationItem
              key={a.annotation_id || i}
              a={a}
              sourceLabel={(showCommitHashes ? (member.sha ? member.sha.slice(0, 7) : '—') : 'member') + (member.flagged ? ' 🚩' : '')}
              onClick={() => onSelectCommit(member.id)}
            />
          ))}
        </div>
      )}
    </Box>
  );
}

// Fetch + parse one commit's `git show` once, shared by every panel that needs
// it (the git-diff box and the bash "output" box both read the same parse, so
// the pane-log diff isn't fetched twice and both agree on which file is which).
// Returns 'idle' for an empty sha so callers can mount it unconditionally.
function useCommitDiff(sha) {
  const { selectedInput } = useData();
  const [state, setState] = React.useState({ status: 'loading', text: '', error: null });

  const fetchDiff = React.useCallback(async () => {
    if (!sha) { setState({ status: 'idle', text: '', error: null }); return; }
    setState({ status: 'loading', text: '', error: null });
    try {
      const r = await fetch(`/api/diff?sha=${encodeURIComponent(sha)}${nameParam(selectedInput)}`);
      const text = await r.text();
      if (!r.ok) throw new Error(text || `HTTP ${r.status}`);
      setState({ status: 'ready', text, error: null });
    } catch (err) {
      setState({ status: 'error', text: '', error: err.message });
    }
  }, [sha, selectedInput]);

  React.useEffect(() => { fetchDiff(); }, [fetchDiff]);

  const parsed = React.useMemo(() => (state.status === 'ready' ? parseDiff(state.text) : null), [state.status, state.text]);
  return { ...state, parsed, reload: fetchDiff };
}

// The pane log a user-shell command wrote to lives at
// logs/terminal_logs/pane_<session>.log; find that file in a parsed commit diff
// (falling back to any pane_*.log) so the "output" box can render its diff and
// the git-diff box can defer to that box with a "see above".
function findPaneFile(parsed, session) {
  if (!parsed) return null;
  const all = [...parsed.logs, ...parsed.other];
  if (session) {
    const want = `pane_${session}.log`;
    const exact = all.find((f) => f.path === `logs/terminal_logs/${want}` || f.path.endsWith(`/${want}`) || f.path === want);
    if (exact) return exact;
  }
  return all.find((f) => /(^|\/)pane_[^/]*\.log$/.test(f.path)) || null;
}

// The bash "output" block: the pane log this user-shell command wrote, rendered
// as its git diff (changed lines, green/red) rather than raw text, pulled from
// the same shared commit-diff parse the git-diff box uses. Sits between the
// shell-context and git-diff boxes; the git-diff box's log table defers to it.
function PaneOutputBox({ diff, panePath }) {
  const [full, setFull] = React.useState(false);
  const { status, parsed } = diff;
  const file = React.useMemo(
    () => (parsed && panePath ? [...parsed.logs, ...parsed.other].find((f) => f.path === panePath) : null),
    [parsed, panePath],
  );
  // Only the changed (+/−) lines — pane logs are append-heavy, so the diff reads
  // as mostly green; same treatment as the git-diff box's log-file rows.
  const changed = React.useMemo(
    () => (file ? file.body.filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)) : []),
    [file],
  );
  if (status === 'loading') return <LoadingBox label="loading output" height={48} />;
  if (status !== 'ready' || !file || changed.length === 0) return null;
  const adds = changed.filter((l) => /^\+/.test(l)).length;
  const dels = changed.filter((l) => /^-/.test(l)).length;
  const bigLog = changed.length > BIG_FILE_LINES;
  const shown = bigLog && !full ? changed.slice(0, PREVIEW_LINES) : changed;
  return (
    <Box style={{ padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <L size={12} weight={600}>output</L>
        <L mono size={10} color={WF.ink3} style={{ wordBreak: 'break-all' }}>{file.path}</L>
        {adds > 0 && <L mono size={11} color={WF.tagGreenFg}>+{adds}</L>}
        {dels > 0 && <L mono size={11} color={WF.heat4}>−{dels}</L>}
      </div>
      <div style={{ marginTop: 8, border: `1px solid ${WF.rule}` }}>
        <ColoredDiffBody lines={shown} maxHeight={null} />
        {bigLog && !full && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderTop: `1px solid ${WF.rule}` }}>
            <L mono size={11} color={WF.ink3}>showing first {PREVIEW_LINES} of {changed.length} changed lines</L>
            <div style={{ flex: 1 }} />
            <Chip style={{ cursor: 'pointer' }} onClick={() => setFull(true)}>render full output</Chip>
          </div>
        )}
      </div>
      {/* A long pane log is hard to read in this panel; nudge the auditor toward
          the real file. The ↺ git checkout affordance lives in the dossier header. */}
      {bigLog && (
        <L mono size={10} color={WF.ink3} style={{ display: 'block', marginTop: 6, lineHeight: 1.45 }}>
          {changed.length} changed lines — for close analysis, <strong style={{ color: WF.ink2 }}>↺ git checkout</strong> this commit (header above) and open <code>{file.path}</code> directly.
        </L>
      )}
    </Box>
  );
}

function DiffPanel({ sha, diff, panePath }) {
  const { status, parsed, error, reload: fetchDiff } = diff;

  return (
    <Box style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <L size={13} weight={700}>git diff</L>
        <Sha sha={sha} len={12} size={10} color={WF.ink3} />
        {parsed && (
          <L mono size={10} color={WF.ink3}>
            · {parsed.logs.length} log file{parsed.logs.length === 1 ? '' : 's'} · {parsed.other.length} other
          </L>
        )}
        <div style={{ flex: 1 }} />
        <Chip style={{ cursor: 'pointer' }} onClick={fetchDiff}>reload</Chip>
      </div>
      {status === 'loading' && (
        <LoadingBox label="loading diff" height={64} style={{ marginTop: 8 }} />
      )}
      {status === 'error' && (
        <L mono size={11} color={WF.heat4} style={{ display: 'block', marginTop: 8 }}>error: {error}</L>
      )}
      {status === 'ready' && parsed && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {parsed.other.length > 0 && (
            <DiffGroup
              title={parsed.logs.length > 0 ? 'other files' : 'files'}
              accent={WF.ink}
              files={parsed.other}
              sha={sha}
            />
          )}
          {/* Commit message and log artifacts sit below the diffs: the source
              changes are what's under audit, so they lead; the commit message
              and append-heavy (collapsed) trace logs follow. */}
          {parsed.commitMessage && <CommitHeader text={parsed.commitMessage} />}

          {parsed.logs.length > 0 && (
            <LogDiffTable
              files={parsed.logs}
              panePath={panePath}
            />
          )}
          {parsed.logs.length === 0 && parsed.other.length === 0 && (
            <L mono size={11} color={WF.ink3}>no file changes (commit metadata only)</L>
          )}
        </div>
      )}
    </Box>
  );
}

// Split `git show` output into:
//   commitMessage: indented commit-message lines from the header
//   logs / other:  one entry per file, classified by path prefix
// Exported so the semantic-areas screen can reuse the same parser to build a
// per-file, commit-by-commit progression out of each commit's `git show`.
export function parseDiff(text) {
  const lines = text.split('\n');
  let i = 0;
  // Skip past the commit header (commit/Author/AuthorDate/Commit/CommitDate)
  // and capture the indented commit-message lines that follow.
  const msg = [];
  while (i < lines.length && !/^diff --git /.test(lines[i])) {
    const line = lines[i];
    if (/^ {4}/.test(line)) msg.push(line.slice(4));
    i++;
  }
  const files = [];
  while (i < lines.length) {
    if (!/^diff --git /.test(lines[i])) { i++; continue; }
    const m = lines[i].match(/^diff --git a\/(.+?) b\/(.+)$/);
    const path = m ? m[2] : '(unknown)';
    i++;
    const meta = []; // index/mode/rename lines
    while (
      i < lines.length &&
      !/^diff --git /.test(lines[i]) &&
      !/^@@/.test(lines[i]) &&
      !/^Binary files /.test(lines[i])
    ) {
      // Skip the standard +++/--- header pair; keep mode/rename/index lines compactly.
      if (!/^(\+\+\+|---) /.test(lines[i])) meta.push(lines[i]);
      i++;
    }
    // Collect body (hunks or "Binary files differ").
    const body = [];
    while (i < lines.length && !/^diff --git /.test(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    // Trim trailing blank lines.
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    // Trim index/mode noise: keep only rename/new file/deleted file/binary indicators.
    const cleanedMeta = meta.filter((l) => (
      /^(new file mode|deleted file mode|rename from|rename to|similarity index|copy from|copy to|Binary files)/.test(l)
    ));
    files.push({ path, meta: cleanedMeta, body, isBinary: body.some((l) => /^Binary files /.test(l)) });
  }
  const logs = files.filter((f) => /^logs\//.test(f.path));
  const other = files.filter((f) => !/^logs\//.test(f.path));
  return { commitMessage: msg.join('\n').trim(), logs, other };
}

// Same foldable-header format as LogDiffTable / DiffGroup — a caret, a category
// swatch, and a bold section title that is itself the collapse point — so the
// commit message reads as a peer section of the diffs and log files below it.
export function CommitHeader({ text }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <div
        onClick={() => setOpen((v) => !v)}
        title={open ? 'collapse commit message' : 'expand commit message'}
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: open ? 8 : 0, cursor: 'pointer', userSelect: 'none' }}
      >
        <L mono size={11} color={WF.ink2} style={{ width: 12, textAlign: 'center' }}>{open ? '▾' : '▸'}</L>
        <div style={{ width: 12, height: 12, background: WF.ink3, border: inkBorder() }} />
        <L size={13} weight={700}>commit message</L>
      </div>
      {open && (
        <Box style={{ padding: 10, background: WF.paperAlt, borderColor: WF.rule2 }}>
          <pre
            style={{
              fontFamily: WF.monoFont,
              fontSize: 11,
              margin: 0,
              color: WF.ink2,
              lineHeight: 1.45,
              whiteSpace: 'pre-wrap',
            }}
          >{text}</pre>
        </Box>
      )}
    </div>
  );
}

// Rendering guards. A diff renders one <span> per line, so a single huge file
// or a commit touching hundreds of files can produce tens of thousands of DOM
// nodes and freeze (or crash) the tab. Past these thresholds we collapse to a
// preview / file list and let the auditor opt into the full render per file.
export const BIG_FILE_LINES = 200;  // hunk-body lines before a single file is previewed
export const PREVIEW_LINES = 30;    // lines shown up front for a big file
const MANY_FILES = 15;       // files in one diff before they render as a list
const TOTAL_LINES = 1200;    // summed hunk-body lines before files render as a list

// Per-file context-expansion steps for FileDiff's up/down buttons — the count of
// surrounding lines each press reveals in that direction. The fetch hands
// max(up,down) to /api/filediff as `-U<n>`; the last step is a large value git
// caps at the file's actual length, i.e. "to the end of the file".
const CTX_STEPS = [10, 25, 60, 150, 100000];

export function DiffGroup({ title, accent, files, sha, oldSha, hint }) {
  // List mode: render every file as a collapsed header row (path + ±counts
  // + badges) so a heavy commit is a scannable list, not hundreds of open diffs.
  // Triggered by file count OR cumulative line count — many small files add up
  // to the same DOM blowup as a few big ones. Each row expands its own diff on
  // click; "expand all" opens the lot.
  const totalLines = React.useMemo(() => files.reduce((n, f) => n + f.body.length, 0), [files]);
  const listMode = files.length > MANY_FILES || totalLines > TOTAL_LINES;
  // Per-file open state. A heavy (listMode) commit defaults every file collapsed
  // — the list is meant to be scanned, then drilled into. A normal commit
  // defaults every file expanded but keeps the same per-file collapse toggle, so
  // a long file (e.g. a big run.py) can be folded away without losing your place.
  // Reset to the per-mode default whenever the file set changes — i.e. a new
  // commit is opened — which also clears stale indices from the previous commit.
  const filesKey = React.useMemo(() => files.map((f) => f.path).join(' '), [files]);
  const [openIdx, setOpenIdx] = React.useState(
    () => (listMode ? new Set() : new Set(files.map((_, i) => i))),
  );
  React.useEffect(() => {
    setOpenIdx(listMode ? new Set() : new Set(files.map((_, i) => i)));
  }, [filesKey, listMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleIdx = (i) =>
    setOpenIdx((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const allOpen = openIdx.size === files.length;
  const setAll = () => setOpenIdx(allOpen ? new Set() : new Set(files.map((_, i) => i)));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ width: 12, height: 12, background: accent, border: inkBorder() }} />
        <L size={13} weight={700}>{title}</L>
        <Chip>{files.length}</Chip>
        {hint && !listMode && <L mono size={10} color={WF.ink3}>· {hint}</L>}
        {listMode && (
          <L mono size={10} color={WF.ink3}>
            · {files.length > MANY_FILES ? `${files.length} files` : `${totalLines} lines`} — collapsed, click to expand
          </L>
        )}
        {files.length > 1 && (
          <>
            <div style={{ flex: 1 }} />
            <Chip style={{ cursor: 'pointer' }} onClick={setAll}>{allOpen ? 'collapse all' : 'expand all'}</Chip>
          </>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: listMode ? 6 : 14 }}>
        {files.map((f, i) => (
          <FileDiff
            key={f.path + ':' + i}
            file={f}
            sha={sha}
            oldSha={oldSha}
            collapsible
            open={openIdx.has(i)}
            onToggle={() => toggleIdx(i)}
          />
        ))}
      </div>
    </div>
  );
}

// Log-file diffs collapsed into a single box: one table row per file, with the
// file path on the left and only that file's changed (+/−) lines on the right.
// Logs are append-heavy trace artifacts, so dropping the hunk headers and
// context lines keeps the box scannable; the per-commit FileDiff treatment
// (with images, full context) is reserved for source files.
export function LogDiffTable({ files, hint, panePath }) {
  const border = `1px solid ${WF.rule}`;
  // The whole log-files box folds away from its header — append-heavy trace
  // artifacts are rarely the thing under audit, so let them be tucked out of the
  // way while keeping the section header (and file count) in view. Collapsed by
  // default; the header and file count stay visible so it's a one-click expand.
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <div
        onClick={() => setOpen((v) => !v)}
        title={open ? 'collapse log files' : 'expand log files'}
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: open ? 8 : 0, cursor: 'pointer', userSelect: 'none' }}
      >
        <L mono size={11} color={WF.ink2} style={{ width: 12, textAlign: 'center' }}>{open ? '▾' : '▸'}</L>
        <div style={{ width: 12, height: 12, background: WF.ink2, border: inkBorder() }} />
        <L size={13} weight={700}>log files</L>
        <Chip>{files.length}</Chip>
        {hint && <L mono size={10} color={WF.ink3}>· {hint}</L>}
      </div>
      {open && (
        <Box style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '32%' }} />
              <col style={{ width: '68%' }} />
            </colgroup>
            <tbody>
              {files.map((f, i) => (
                <LogDiffRow key={f.path + ':' + i} file={f} first={i === 0} border={border} isPane={f.path === panePath} />
              ))}
            </tbody>
          </table>
        </Box>
      )}
    </div>
  );
}

function LogDiffRow({ file, first, border, isPane }) {
  const [full, setFull] = React.useState(false);
  const adds = file.body.filter((l) => /^\+[^+]/.test(l)).length;
  const dels = file.body.filter((l) => /^-[^-]/.test(l)).length;
  const isNew = file.meta.some((l) => /^new file mode/.test(l));
  const isDeleted = file.meta.some((l) => /^deleted file mode/.test(l));
  // Only the changed lines — additions and deletions. Hunk headers (@@) and
  // unchanged context lines are dropped: log diffs are mostly appends, so the
  // +/− lines carry the signal.
  const changed = file.body.filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  // Log appends can run to thousands of lines; the row has no scroll cap, so
  // preview-then-expand keeps a single noisy log from freezing the panel.
  const bigLog = changed.length > BIG_FILE_LINES;
  const shown = bigLog && !full ? changed.slice(0, PREVIEW_LINES) : changed;
  const cell = { borderTop: first ? 'none' : border, verticalAlign: 'top' };
  return (
    <tr>
      <td style={{ ...cell, borderRight: border, background: WF.paperAlt, padding: '8px 10px' }}>
        {/* Path and counts share one line, so a single-line log diff is a
            single-line row (path · +1) rather than path-over-count. */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <L mono size={11} weight={700} style={{ wordBreak: 'break-all' }}>{file.path}</L>
          {adds > 0 && <L mono size={11} color={WF.tagGreenFg}>+{adds}</L>}
          {dels > 0 && <L mono size={11} color={WF.heat4}>−{dels}</L>}
          {bigLog && <Chip style={{ background: WF.tagAmberBg, borderColor: WF.tagAmberFg }}>large · {changed.length} lines</Chip>}
          {file.isBinary && <Chip>binary</Chip>}
          {isNew && <Chip>new file</Chip>}
          {isDeleted && <Chip>deleted</Chip>}
        </div>
      </td>
      <td style={{ ...cell, padding: 0 }}>
        {isPane ? (
          // This commit's pane log is rendered in full as the "output" box above
          // the git diff, so don't repeat its (often hundreds of lines) diff here.
          <L mono size={11} color={WF.ink3} style={{ display: 'block', padding: '8px 10px' }}>
            ↑ shown above as <strong style={{ color: WF.ink2 }}>output</strong>
          </L>
        ) : file.isBinary ? (
          <L mono size={11} color={WF.ink3} style={{ display: 'block', padding: '8px 10px' }}>binary file — no line diff</L>
        ) : changed.length > 0 ? (
          <>
            <ColoredDiffBody lines={shown} maxHeight={null} />
            {bigLog && !full && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderTop: border }}>
                <L mono size={11} color={WF.ink3}>showing first {PREVIEW_LINES} of {changed.length} changed lines</L>
                <div style={{ flex: 1 }} />
                <Chip style={{ cursor: 'pointer' }} onClick={() => setFull(true)}>render full log diff</Chip>
              </div>
            )}
          </>
        ) : (
          <L mono size={11} color={WF.ink3} style={{ display: 'block', padding: '8px 10px' }}>no line changes</L>
        )}
      </td>
    </tr>
  );
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp)$/i;

// git's `-U<n>` is symmetric — it can't give more lines above a hunk than below.
// So FileDiff fetches one patch at `-U<max(up,down)>` and `trimHunks` carves it
// back to `up` context lines before each hunk's first change and `down` after
// its last, rewriting the `@@` header counts to stay honest. This is what lets
// the top/bottom buttons grow in one direction independently.
function trimHunks(body, up, down) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    if (!/^@@/.test(body[i])) { out.push(body[i]); i++; continue; }
    const header = body[i]; i++;
    const hunk = [];
    while (i < body.length && !/^@@/.test(body[i])) { hunk.push(body[i]); i++; }
    const firstChange = hunk.findIndex((l) => /^[+-]/.test(l));
    if (firstChange === -1) { out.push(header, ...hunk); continue; } // no change → leave as-is
    let lastChange = firstChange;
    for (let k = hunk.length - 1; k > firstChange; k--) { if (/^[+-]/.test(hunk[k])) { lastChange = k; break; } }
    const lead = hunk.slice(0, firstChange);            // leading context (closest to change is last)
    const mid = hunk.slice(firstChange, lastChange + 1); // change region + interior context
    const trail = hunk.slice(lastChange + 1);            // trailing context (closest to change is first)
    const keepLead = up >= lead.length ? lead : lead.slice(lead.length - up);
    const keepTrail = down >= trail.length ? trail : trail.slice(0, down);
    out.push(
      adjustHunkHeader(header, lead.length - keepLead.length, trail.length - keepTrail.length),
      ...keepLead, ...mid, ...keepTrail,
    );
  }
  return out;
}

// Shift a `@@ -os,oc +ns,nc @@` header after dropping `rLead` leading and `rTail`
// trailing context lines: starts move forward by the leading lines removed, both
// counts shrink by the total removed (context counts toward old and new alike).
function adjustHunkHeader(h, rLead, rTail) {
  if (!rLead && !rTail) return h;
  const m = h.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!m) return h;
  const os = +m[1] + rLead, oc = (m[2] == null ? 1 : +m[2]) - rLead - rTail;
  const ns = +m[3] + rLead, nc = (m[4] == null ? 1 : +m[4]) - rLead - rTail;
  return `@@ -${os},${oc} +${ns},${nc} @@${m[5]}`;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Split a diff body into its hunks, each carrying the old/new start+count from
// its `@@` header so callers can reason about the line ranges *between* hunks —
// the unchanged gap git omits when two edit clusters sit more than `-U` lines
// apart. `lines` excludes the header; `header` keeps it for re-rendering.
function splitHunks(body) {
  const hunks = [];
  let cur = null;
  for (const line of body) {
    const m = line.match(HUNK_RE);
    if (m) {
      cur = {
        header: line,
        oldStart: +m[1], oldCount: m[2] == null ? 1 : +m[2],
        newStart: +m[3], newCount: m[4] == null ? 1 : +m[4],
        lines: [],
      };
      hunks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return hunks;
}

// Map new-file line number → its raw diff line, walked over a full-context patch
// body. Used to fill an expanded gap: the in-between region is unchanged, so the
// lines we splice back come from this map keyed by their new-file position.
function buildNewLineMap(body) {
  const map = new Map();
  let oldNo = 0, newNo = 0, seeded = false;
  for (const line of body) {
    const m = line.match(HUNK_RE);
    if (m) { oldNo = +m[1]; newNo = +m[3]; seeded = true; continue; }
    if (!seeded || line.startsWith('\\')) continue; // pre-hunk / "No newline" marker
    if (line.startsWith('+')) { map.set(newNo, line); newNo++; }
    else if (line.startsWith('-')) { oldNo++; }
    else { map.set(newNo, line); newNo++; oldNo++; }
  }
  return map;
}

// Per-line old/new numbers for the gutter, walked from each `@@` header. `+`
// lines advance only the new side, `-` only the old, context both; headers and
// the "No newline" marker get no number. `width` is the widest number's digit
// count, so the gutter sizes to the file without wasting space on small ones.
function computeLineNos(lines) {
  const nos = new Array(lines.length);
  let oldNo = 0, newNo = 0, seeded = false, maxNo = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(HUNK_RE);
    if (m) { oldNo = +m[1]; newNo = +m[3]; seeded = true; nos[i] = null; continue; }
    if (!seeded || line.startsWith('\\')) { nos[i] = null; continue; }
    if (line.startsWith('+')) { nos[i] = { o: null, n: newNo }; maxNo = Math.max(maxNo, newNo); newNo++; }
    else if (line.startsWith('-')) { nos[i] = { o: oldNo, n: null }; maxNo = Math.max(maxNo, oldNo); oldNo++; }
    else { nos[i] = { o: oldNo, n: newNo }; maxNo = Math.max(maxNo, oldNo, newNo); oldNo++; newNo++; }
  }
  return { nos, width: String(maxNo || 1).length };
}

// Nearest scrollable ancestor, so the scroll-anchor adjustment moves the panel
// the diff actually lives in (the detail pane is its own overflow:auto box, not
// the window). Falls back to the document scroller.
function getScrollParent(el) {
  let p = el && el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    p = p.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

// Exported for reuse by the semantic-areas screen's per-file progression.
// `collapsible` + controlled `open`/`onToggle` let DiffGroup render a big commit
// as a click-to-expand file list; omitted, the diff is always shown (the legacy
// behaviour the semantic-areas screen relies on). The big-body line guard
// applies in either mode. `hideHeader` drops the path/badge header (and its
// surrounding box) and renders just the diff body — for the change-by-change
// step, where the enclosing FileEditStep already frames the file and commit.
export function FileDiff({ file, sha, oldSha, collapsible = false, open = false, onToggle, hideHeader = false }) {
  const { selectedInput } = useData();
  const { showLineNumbers } = useSettings();
  const [full, setFull] = React.useState(false); // opted into the full big-file body
  // Directional context expansion. `upIdx`/`downIdx` are null (committed ±3) or
  // an index into CTX_STEPS giving the lines to show above / below each hunk.
  // git's -U is symmetric, so we fetch one patch at max(up,down) context and
  // trimHunks carves it back per-direction; `+/-` counts come from the original
  // body since context lines never change them.
  const [upIdx, setUpIdx] = React.useState(null);
  const [downIdx, setDownIdx] = React.useState(null);
  const [fetched, setFetched] = React.useState({ status: 'idle', body: null, error: null });
  // Gaps the auditor has filled, keyed by their new-file line range. A different
  // commit / file gets a clean slate — gap keys are line numbers, so a stale set
  // wouldn't match anyway, but resetting also drops the full-file fetch below.
  const [expandedGaps, setExpandedGaps] = React.useState(() => new Set());
  const [gapFetch, setGapFetch] = React.useState({ status: 'idle', map: null });
  React.useEffect(() => { setExpandedGaps(new Set()); }, [sha, oldSha, file.path]);
  const adds = file.body.filter((l) => /^\+[^+]/.test(l)).length;
  const dels = file.body.filter((l) => /^-[^-]/.test(l)).length;
  const isImage = IMAGE_EXT_RE.test(file.path);
  const isNew = file.meta.some((l) => /^new file mode/.test(l));
  const isDeleted = file.meta.some((l) => /^deleted file mode/.test(l));
  // Expansion only reveals surrounding *unchanged* lines, so it's meaningless
  // for images/binaries and for whole-file adds/deletes (no context to show).
  const canExpand = !isImage && !file.isBinary && !isNew && !isDeleted && file.body.length > 0;

  const upLines = upIdx == null ? 3 : CTX_STEPS[upIdx];
  const downLines = downIdx == null ? 3 : CTX_STEPS[downIdx];
  const expandActive = upIdx != null || downIdx != null;
  const fetchCtx = Math.max(upLines, downLines);

  // One fetch per distinct max-context level; bumping only the smaller direction
  // re-trims the cached body without hitting the server again.
  React.useEffect(() => {
    if (!expandActive) { setFetched({ status: 'idle', body: null, error: null }); return; }
    let alive = true;
    const base = oldSha || `${sha}~1`;
    const qs = `base=${encodeURIComponent(base)}&target=${encodeURIComponent(sha)}`
      + `&path=${encodeURIComponent(file.path)}&context=${fetchCtx}${nameParam(selectedInput)}`;
    setFetched((s) => ({ ...s, status: 'loading', error: null }));
    (async () => {
      try {
        const r = await fetch(`/api/filediff?${qs}`);
        const text = await r.text();
        if (!r.ok) throw new Error(text || `HTTP ${r.status}`);
        const parsed = parseDiff(text);
        const one = [...parsed.other, ...parsed.logs][0];
        if (alive) setFetched({ status: 'ready', body: one ? one.body : [], error: null });
      } catch (err) {
        if (alive) setFetched({ status: 'error', body: null, error: err.message });
      }
    })();
    return () => { alive = false; };
  }, [expandActive, fetchCtx, sha, oldSha, file.path, selectedInput]);

  // Gap fill is sourced from one full-context patch (git caps the huge -U at the
  // file length), fetched once the first gap is opened. It's deliberately
  // separate from the up/down fetch above: that one is symmetric and would also
  // balloon the file's ends, whereas a gap fills only its own in-between range —
  // we just index the full patch by new-file line and splice that slice back in.
  // Keyed on the boolean (any gap open?), not the set or the fetch status: a
  // second gap reuses the one full-file map, and — critically — flipping our own
  // status to 'loading' must NOT re-run this effect, or its cleanup would cancel
  // the in-flight fetch and strand the bar on "expanding".
  const gapsActive = expandedGaps.size > 0;
  React.useEffect(() => {
    if (!gapsActive) { setGapFetch({ status: 'idle', map: null }); return; }
    let alive = true;
    const base = oldSha || `${sha}~1`;
    const qs = `base=${encodeURIComponent(base)}&target=${encodeURIComponent(sha)}`
      + `&path=${encodeURIComponent(file.path)}&context=100000${nameParam(selectedInput)}`;
    setGapFetch({ status: 'loading', map: null });
    (async () => {
      try {
        const r = await fetch(`/api/filediff?${qs}`);
        const text = await r.text();
        if (!r.ok) throw new Error(text || `HTTP ${r.status}`);
        const one = [...parseDiff(text).other, ...parseDiff(text).logs][0];
        if (alive) setGapFetch({ status: 'ready', map: one ? buildNewLineMap(one.body) : new Map() });
      } catch {
        if (alive) setGapFetch({ status: 'error', map: null });
      }
    })();
    return () => { alive = false; };
  }, [gapsActive, sha, oldSha, file.path, selectedInput]);

  // Active body: the fetched patch trimmed to the current up/down, else the
  // committed diff. Big-file / preview thresholds key off whatever's on screen
  // so a full-file expansion still gets the responsiveness guard.
  const activeBody = React.useMemo(() => (
    expandActive && fetched.status === 'ready' && fetched.body
      ? trimHunks(fetched.body, upLines, downLines)
      : file.body
  ), [expandActive, fetched.status, fetched.body, upLines, downLines, file.body]);

  // The body actually rendered, plus the gap markers ColoredDiffBody draws.
  // We walk the hunks of `activeBody`: the unchanged run between hunk i-1 and i
  // is a gap. An opened gap (key = its new-line range) whose fill has loaded is
  // spliced in and the now-redundant `@@` header dropped, so the two hunks read
  // as one continuous stretch; otherwise we leave a marker before the header for
  // the GapBar. `gapAt` is keyed by index into the emitted `renderLines`.
  const fullMap = gapFetch.status === 'ready' ? gapFetch.map : null;
  const { renderLines, gapAt } = React.useMemo(() => {
    const hunks = splitHunks(activeBody);
    if (hunks.length <= 1) return { renderLines: activeBody, gapAt: null };
    const out = [];
    const marks = {};
    hunks.forEach((h, i) => {
      if (i > 0) {
        const prev = hunks[i - 1];
        const from = prev.newStart + prev.newCount; // first unchanged new-line
        const to = h.newStart - 1;                  // last unchanged new-line
        const count = to - from + 1;
        if (count > 0) {
          const key = `${from}-${to}`;
          if (expandedGaps.has(key) && fullMap) {
            for (let n = from; n <= to; n++) out.push(fullMap.get(n) ?? ' ');
            out.push(...h.lines); // drop the header — contiguous now
            return;
          }
          marks[out.length] = { key, count, expanding: expandedGaps.has(key) };
        }
      }
      out.push(h.header, ...h.lines);
    });
    return { renderLines: out, gapAt: marks };
  }, [activeBody, expandedGaps, fullMap]);

  // Scroll-anchoring. On a direction button press we record a viewport y on the
  // file card — its bottom edge when growing up, its top edge when growing down —
  // then in useLayoutEffect (after the new body lays out) scroll the enclosing
  // pane by the delta so the change region the auditor is reading stays put while
  // the rest of the page slides to make room.
  const boxRef = React.useRef(null);
  const anchor = React.useRef(null);
  const armAnchor = (dir) => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    anchor.current = { y: dir === 'up' ? r.bottom : r.top, dir };
  };
  React.useLayoutEffect(() => {
    const a = anchor.current;
    if (!a || !boxRef.current) return;
    anchor.current = null;
    const r = boxRef.current.getBoundingClientRect();
    const delta = (a.dir === 'up' ? r.bottom : r.top) - a.y;
    if (delta) getScrollParent(boxRef.current).scrollBy(0, delta);
  }, [renderLines]);

  const bumpUp = () => { armAnchor('up'); setUpIdx((i) => (i == null ? 0 : Math.min(i + 1, CTX_STEPS.length - 1))); };
  const bumpDown = () => { armAnchor('down'); setDownIdx((i) => (i == null ? 0 : Math.min(i + 1, CTX_STEPS.length - 1))); };
  // A gap grows in the middle; anchor the card's top so the lines above stay put
  // and the fill pushes everything below it down.
  const expandGap = (key) => { armAnchor('down'); setExpandedGaps((s) => new Set(s).add(key)); };
  const reset = () => { armAnchor('down'); setUpIdx(null); setDownIdx(null); setExpandedGaps(new Set()); };

  const bodyLines = activeBody.length;
  const isBig = !isImage && !file.isBinary && bodyLines > BIG_FILE_LINES;
  const showBody = hideHeader || (collapsible ? open : true);
  // A new file with no hunk body is an empty (0-byte) file — git emits the
  // `new file mode` header but no `+` lines. Flag it so we can say so explicitly
  // instead of leaving a bare header with nothing under it.
  const isEmptyNewFile = isNew && !isImage && !file.isBinary && bodyLines === 0;

  const emptyFileNote = (
    <L mono size={11} color={WF.ink3} style={{ display: 'block', padding: '8px 10px', fontStyle: 'italic' }}>
      empty file
    </L>
  );

  // The diff body — image filmstrip, big-file preview, or the source diff with
  // its directional context controls. Shared by the boxed (header) layout and
  // the bare hideHeader layout the change-by-change step uses.
  const bodyContent = showBody && (
    isImage ? (
      <ImageDiff sha={sha} oldSha={oldSha} path={file.path} hasOld={!isNew} hasNew={!isDeleted} />
    ) : isBig && !full ? (
      <>
        <ColoredDiffBody lines={activeBody.slice(0, PREVIEW_LINES)} maxHeight={null} lineNumbers={showLineNumbers} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            background: WF.paperAlt,
            borderTop: `1px solid ${WF.rule}`,
          }}
        >
          <L mono size={11} color={WF.ink3}>
            showing first {PREVIEW_LINES} of {bodyLines} lines — held back to keep the tab responsive
          </L>
          <div style={{ flex: 1 }} />
          <Chip style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); setFull(true); }}>
            render full diff
          </Chip>
        </div>
      </>
    ) : (
      activeBody.length > 0 && (
        <>
          {canExpand && (
            <ExpandBar
              dir="up" idx={upIdx} lines={upLines}
              status={fetched.status} error={fetched.error}
              onMore={bumpUp} onReset={expandActive || gapsActive ? reset : null}
            />
          )}
          <ColoredDiffBody
            lines={renderLines}
            maxHeight={expandActive || gapsActive ? null : 960}
            lineNumbers={showLineNumbers}
            gapAt={gapAt}
            onExpandGap={expandGap}
          />
          {canExpand && (
            <ExpandBar
              dir="down" idx={downIdx} lines={downLines}
              status={fetched.status} error={fetched.error}
              onMore={bumpDown} onReset={expandActive || gapsActive ? reset : null}
            />
          )}
        </>
      )
    )
  );

  // hideHeader: the FileEditStep box and its commit strip already frame this, so
  // render the body alone (keeping boxRef for the context-expansion scroll
  // anchor). Empty body ⇒ a small note so the step isn't a bare strip.
  if (hideHeader) {
    return (
      <div ref={boxRef}>
        {bodyContent || (isEmptyNewFile ? emptyFileNote : (
          <L mono size={11} color={WF.ink3} style={{ display: 'block', padding: '8px 10px' }}>
            no line changes for this file in this commit
          </L>
        ))}
      </div>
    );
  }

  return (
    <div ref={boxRef}>
    <Box style={{ padding: 0, overflow: 'hidden' }}>
      <div
        onClick={collapsible ? onToggle : undefined}
        title={collapsible ? (open ? 'collapse this file' : 'expand this file') : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          background: WF.paperAlt,
          borderBottom: showBody ? `1px solid ${WF.rule}` : 'none',
          cursor: collapsible ? 'pointer' : 'default',
        }}
      >
        {collapsible && <L mono size={11} color={WF.ink2}>{open ? '▾' : '▸'}</L>}
        <L mono size={12} weight={700} style={{ wordBreak: 'break-all' }}>{file.path}</L>
        <div style={{ flex: 1 }} />
        {!isImage && adds > 0 && <L mono size={11} color={WF.tagGreenFg}>+{adds}</L>}
        {!isImage && dels > 0 && <L mono size={11} color={WF.heat4}>−{dels}</L>}
        {isBig && <Chip style={{ background: WF.tagAmberBg, borderColor: WF.tagAmberFg }}>large · {bodyLines} lines</Chip>}
        {file.isBinary && !isImage && <Chip>binary</Chip>}
        {isImage && <Chip>image</Chip>}
        {isNew && <Chip>new file</Chip>}
        {isDeleted && <Chip>deleted</Chip>}
        {file.meta.filter((l) => !/^(new file mode|deleted file mode)/.test(l)).length > 0 && (
          <L mono size={10} color={WF.ink3}>
            {file.meta.filter((l) => !/^(new file mode|deleted file mode)/.test(l)).join(' · ')}
          </L>
        )}
      </div>
      {bodyContent}
      {showBody && !bodyContent && isEmptyNewFile && emptyFileNote}
    </Box>
    </div>
  );
}

// One directional context control, rendered above (dir 'up') or below (dir
// 'down') a source-file diff body. Each press steps that direction through
// CTX_STEPS, re-trimming (and refetching only when its line count exceeds the
// other direction's) so the body grows just that way. Lives outside the collapse
// header, so its clicks never toggle the file open/closed.
function ExpandBar({ dir, idx, lines, status, error, onMore, onReset }) {
  const atMax = idx === CTX_STEPS.length - 1;
  const arrow = dir === 'up' ? '↑' : '↓';
  const word = dir === 'up' ? 'above' : 'below';
  const label = idx == null ? `±3 ${word}`
    : lines >= 100000 ? (dir === 'up' ? 'to file start' : 'to file end')
    : `${lines} ${word}`;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 10px',
        background: WF.paperAlt,
        [dir === 'up' ? 'borderBottom' : 'borderTop']: `1px solid ${WF.rule}`,
      }}
    >
      <L mono size={10} color={WF.ink3}>{label}</L>
      {dir === 'up' && status === 'loading' && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <L mono size={10} color={WF.ink3}>· expanding</L>
          <Dots size={4} />
        </span>
      )}
      {dir === 'up' && status === 'error' && <L mono size={10} color={WF.heat4}>· {error}</L>}
      <div style={{ flex: 1 }} />
      {onReset && (
        <Chip style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); onReset(); }}>reset</Chip>
      )}
      <Chip
        style={{ cursor: atMax ? 'default' : 'pointer', opacity: atMax ? 0.4 : 1 }}
        onClick={atMax ? undefined : (e) => { e.stopPropagation(); onMore(); }}
      >
        {arrow} expand {word}
      </Chip>
    </div>
  );
}

// `oldSha` overrides the before-blob revision. Single-commit callers omit it
// (before = sha~1). The cumulative group panel passes the diff base `from~1`,
// since the group's own commits delete/modify files progressively and `sha~1`
// (parent of the group tip) no longer holds the pre-group blobs.
function ImageDiff({ sha, oldSha, path, hasOld, hasNew }) {
  const { selectedInput } = useData();
  const enc = encodeURIComponent(path);
  const n = nameParam(selectedInput);
  const oldRev = oldSha || `${sha}~1`;
  const oldUrl = `/api/blob?sha=${oldRev}&path=${enc}${n}`;
  const newUrl = `/api/blob?sha=${sha}&path=${enc}${n}`;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 14,
        background: WF.paper,
        flexWrap: 'wrap',
      }}
    >
      {hasOld && <ImageThumb url={oldUrl} label="before" tone="del" name={path} />}
      {hasOld && hasNew && <Arrow />}
      {hasNew && <ImageThumb url={newUrl} label={hasOld ? 'after' : 'new'} tone={hasOld ? 'add' : 'new'} name={path} />}
      {!hasOld && !hasNew && (
        <div style={{ width: '100%' }}><NotStoredNote fileName={path.split('/').pop()} /></div>
      )}
    </div>
  );
}

// Shown wherever an image's bytes can't be displayed — a 0-byte placeholder
// blob ('empty'), a blob that failed to fetch ('error'), or a change with no
// before/after data at all. Reassures the auditor this reflects the recording
// pipeline (logger gap / placeholder), not a sabotage signal.
function NotStoredNote({ fileName, label }) {
  return (
    <div style={{ padding: '8px 10px' }}>
      <L mono size={11} weight={700} color={WF.ink} style={{ display: 'block', lineHeight: 1.45 }}>
        <code>{fileName}</code>{label ? <> at the <code>{label}</code> state</> : null} is not stored in the logs.
      </L>
      <L mono size={10} color={WF.ink3} style={{ display: 'block', marginTop: 5, lineHeight: 1.45 }}>
        This is likely due to the logger missing it during the recording process, and is not due to sabotage.
      </L>
    </div>
  );
}

function ImageThumb({ url, label, tone, name }) {
  const fileName = name ? name.split('/').pop() : 'image';
  const [state, setState] = React.useState('loading'); // 'loading' | 'ok' | 'empty' | 'error'
  const onLoad = (e) => {
    const img = e.currentTarget;
    if (img.naturalWidth === 0 && img.naturalHeight === 0) setState('empty');
    else setState('ok');
  };
  const onError = () => setState('error');
  const accent = tone === 'add' ? WF.tagGreenFg : tone === 'del' ? WF.heat4 : WF.ink;
  const bg = tone === 'add' ? WF.tagGreenBg : tone === 'del' ? WF.tagRedBg : WF.paperAlt;
  return (
    <div
      style={{
        width: '40%',
        minWidth: 180,
        border: `1.5px solid ${accent}`,
        background: bg,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '4px 8px', borderBottom: `1px solid ${accent}`, display: 'flex', alignItems: 'center', gap: 6 }}>
        <L mono size={10} weight={700} color={accent}>{label}</L>
        {state === 'empty' && <L mono size={10} color={WF.ink3}>· 0 bytes</L>}
        {state === 'error' && <L mono size={10} color={WF.heat4}>· missing</L>}
      </div>
      <div style={{ background: WF.paper, padding: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 80 }}>
        {(state === 'loading' || state === 'ok' || state === 'empty') && (
          <img
            src={url}
            alt={label}
            onLoad={onLoad}
            onError={onError}
            style={{ maxWidth: '100%', maxHeight: 360, display: state === 'empty' ? 'none' : 'block' }}
          />
        )}
        {(state === 'empty' || state === 'error') && (
          <NotStoredNote fileName={fileName} label={label} />
        )}
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: WF.monoFont,
        fontSize: 22,
        color: WF.ink2,
        padding: '0 4px',
      }}
      aria-hidden
    >
      →
    </div>
  );
}

// Vertical connector between stacked sequence steps (oldest above, newest below).
function DownArrow() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: WF.monoFont,
        fontSize: 22,
        color: WF.ink2,
        padding: '6px 0',
      }}
      aria-hidden
    >
      ↓
    </div>
  );
}

// The "there are unchanged lines here" break rendered between two hunks of the
// same file. A single press fills the whole in-between region at once (the
// auditor wants to see the chasm, not page through it), so this is one button,
// not the stepped up/down control. The vertical padding + dashed rules are the
// spatial gap itself — the body literally separates where the file does.
function GapBar({ count, expanding, onExpand }) {
  const rule = <span style={{ flex: '0 0 18px', borderTop: `1px dotted ${WF.rule2}`, opacity: 0.7 }} />;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minWidth: '100%',
        padding: '13px 10px',
        background: WF.paperAlt,
        borderTop: `1px dashed ${WF.rule2}`,
        borderBottom: `1px dashed ${WF.rule2}`,
      }}
    >
      {rule}
      {expanding ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <L mono size={10} color={WF.ink3}>expanding {count} line{count === 1 ? '' : 's'}</L>
          <Dots size={4} />
        </span>
      ) : (
        <Chip color={WF.ink3} style={{ cursor: 'pointer', whiteSpace: 'nowrap', opacity: 0.6 }} onClick={onExpand}>
          ⋯ expand {count} unchanged line{count === 1 ? '' : 's'} ⋯
        </Chip>
      )}
      <span style={{ flex: 1, borderTop: `1px dotted ${WF.rule2}`, opacity: 0.7 }} />
    </div>
  );
}

// `maxHeight` caps the body and adds vertical scroll (source files, where a
// diff can be hundreds of lines). Pass null to let the body grow to its exact
// line count with no vertical scroll — used by the log table so each row is
// exactly as tall as that file's changed lines.
//
// `lineNumbers` adds the old/new gutter (source diffs only — the log views pass
// filtered changed-lines with no `@@` headers, so there's nothing to count
// against). `gapAt` maps a line index → {count, key, expanding} to render a
// GapBar *before* that line, and `onExpandGap(key)` fills it; both come from
// FileDiff, which owns the gap state and the full-file fetch that backs it.
export function ColoredDiffBody({ lines, maxHeight = 480, lineNumbers = false, gapAt = null, onExpandGap = null }) {
  const { nos, width } = React.useMemo(
    () => (lineNumbers ? computeLineNos(lines) : { nos: null, width: 0 }),
    [lines, lineNumbers],
  );
  // A blank gutter cell pair so `@@` headers and the gap-fill margin still align
  // the content column with numbered rows. Sticky-left keeps it pinned through a
  // horizontal scroll; userSelect:none so copying the diff omits the numbers.
  const numCell = (v) => (
    <span style={{ display: 'inline-block', width: `${width}ch`, textAlign: 'right' }}>{v == null ? '' : v}</span>
  );
  const gutter = (no) => (
    <span
      style={{
        position: 'sticky',
        left: 0,
        flex: 'none',
        display: 'inline-flex',
        gap: 8,
        padding: '0 8px',
        background: WF.paperAlt,
        borderRight: `1px solid ${WF.rule}`,
        color: WF.ink3,
        userSelect: 'none',
      }}
    >
      {numCell(no ? no.o : null)}
      {numCell(no ? no.n : null)}
    </span>
  );
  return (
    <pre
      style={{
        fontFamily: WF.monoFont,
        fontSize: 11,
        margin: 0,
        padding: lineNumbers ? '8px 8px 8px 0' : 8,
        background: WF.paper,
        lineHeight: 1.45,
        maxHeight: maxHeight || undefined,
        overflowX: 'auto',
        overflowY: maxHeight ? 'auto' : 'visible',
        whiteSpace: 'pre',
      }}
    >
      {/* Inner box sizes to the widest line (max-content) but never narrower
          than the visible pane (min-width 100%). The rows are blocks that fill
          THIS box, so every line's background runs the full scroll width —
          short rows line up with long ones instead of each stopping at its own
          text or at the viewport edge. */}
      <div style={{ width: 'max-content', minWidth: '100%' }}>
        {lines.map((line, i) => {
          let color = WF.ink2;
          let bg;
          if (/^@@/.test(line)) { color = WF.tagBlueFg; bg = WF.tagBlueBg; }
          else if (/^Binary files /.test(line)) { color = WF.ink3; }
          else if (/^\+/.test(line)) { color = WF.tagGreenFg; bg = WF.tagGreenBg; }
          else if (/^-/.test(line)) { color = WF.heat4; bg = WF.tagRedBg; }
          const gap = gapAt && gapAt[i];
          const row = lineNumbers ? (
            <div key={i} style={{ display: 'flex', background: bg }}>
              {gutter(nos[i])}
              <span style={{ flex: 'none', padding: '0 6px', color }}>{line || ' '}</span>
            </div>
          ) : (
            <span key={i} style={{ display: 'block', color, background: bg, padding: '0 6px' }}>
              {line || ' '}
            </span>
          );
          if (!gap) return row;
          return (
            <React.Fragment key={`g${i}`}>
              <GapBar count={gap.count} expanding={gap.expanding} onExpand={() => onExpandGap && onExpandGap(gap.key)} />
              {row}
            </React.Fragment>
          );
        })}
      </div>
    </pre>
  );
}

function FlagDetail({ flag, byId, onNavigate }) {
  const { showCommitHashes } = useSettings();
  const related = flag.related_sha;
  const relatedRow = related ? findCommitBySha(byId, related) : null;
  const desc = describeFlag(flag);
  return (
    <div>
      <L size={12} weight={700} color={WF.ink2}>{flag.kind}</L>
      <L size={12} color={WF.ink2} style={{ display: 'block', marginTop: 2 }}>{desc}</L>
      {flag.path && <L mono size={11} color={WF.ink2} style={{ display: 'block', marginTop: 2 }}>{flag.path}</L>}
      {relatedRow && (
        <div
          onClick={() => onNavigate(relatedRow.id)}
          style={{ marginTop: 4, display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}
        >
          <Chip>related →</Chip>
          <L mono size={11}>{showCommitHashes ? `${related.slice(0, 7)} · ` : ''}{relatedRow.title}</L>
        </div>
      )}
    </div>
  );
}

function describeFlag(flag) {
  if (flag.kind === 'add_then_remove') {
    const d = flag.details?.distance_commits;
    return d
      ? `file was added (or modified) here and removed ${d} commits later`
      : 'file was added (or modified) here and later removed';
  }
  if (flag.kind === 'run_scrapped') {
    return 'output produced by this run was deleted before the final commit — often normal iteration (re-run / cleanup), and can also be a logging-process artifact rather than a real anomaly';
  }
  return flag.details ? JSON.stringify(flag.details) : '';
}

function RawLineDetail({ chunk, style }) {
  const rl = chunk.rawLine;
  if (!rl) {
    return (
      <Box style={{ padding: 10, ...style }}>
        <L size={12} weight={600}>event payload</L>
        <L mono size={11} color={WF.ink3} style={{ display: 'block', marginTop: 6 }}>
          (no raw_line — likely the synthetic reconciliation commit)
        </L>
      </Box>
    );
  }
  if (chunk.source === 'audit') {
    return (
      <Box style={{ padding: 10, ...style }}>
        <L size={12} weight={600}>audit event</L>
        <KV k="file"   v={rl.file} />
        <KV k="event"  v={rl.event} />
        <KV k="action" v={rl.action} />
        {rl.baseline && <KV k="baseline" v={rl.baseline} />}
      </Box>
    );
  }
  if (chunk.source === 'commands') {
    return (
      <Box style={{ padding: 10, ...style }}>
        <L size={12} weight={600}>user · shell command</L>
        <Pre>{rl.command || ''}</Pre>
        <KV k="cwd"     v={rl.cwd} />
        <KV k="session" v={rl.session} />
      </Box>
    );
  }
  if (chunk.source === 'claude_tools') {
    const stdout = rl.response?.stdout || '';
    const stderr = rl.response?.stderr || '';
    return (
      <Box style={{ padding: 10, ...style }}>
        <L size={12} weight={600}>claude tool call · {rl.tool}</L>
        {rl.input?.description && (
          <L size={12} color={WF.ink2} style={{ display: 'block', marginTop: 4 }}>{rl.input.description}</L>
        )}
        <div style={{ marginTop: 8 }}>
          <L size={11} weight={600}>input</L>
          <Pre>{formatToolInput(rl.input)}</Pre>
        </div>
        {stdout && (
          <div style={{ marginTop: 8 }}>
            <L size={11} weight={600}>stdout</L>
            <Pre limit={1600}>{stdout}</Pre>
          </div>
        )}
        {stderr && (
          <div style={{ marginTop: 8 }}>
            <L size={11} weight={600} color={WF.heat4}>stderr</L>
            <Pre limit={800}>{stderr}</Pre>
          </div>
        )}
      </Box>
    );
  }
  return (
    <Box style={{ padding: 10, ...style }}>
      <L size={12} weight={600}>event payload</L>
      <Pre>{JSON.stringify(rl, null, 2)}</Pre>
    </Box>
  );
}

function formatToolInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (input.command) return input.command;
  if (input.file_path) {
    const extra = input.content ? `\n---\n${input.content}` : '';
    return input.file_path + extra;
  }
  try { return JSON.stringify(input, null, 2); } catch { return String(input); }
}

function KV({ k, v }) {
  if (v == null || v === '') return null;
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'baseline' }}>
      <L mono size={10} color={WF.ink3} style={{ minWidth: 80 }}>{k}</L>
      <L mono size={11} color={WF.ink2} style={{ overflowWrap: 'anywhere' }}>{v}</L>
    </div>
  );
}

function Pre({ children, limit = 4000 }) {
  const s = typeof children === 'string' ? children : String(children ?? '');
  const truncated = s.length > limit;
  const body = truncated ? s.slice(0, limit) + '\n…' : s;
  return (
    <pre
      style={{
        fontFamily: WF.monoFont,
        fontSize: 11,
        margin: '4px 0 0',
        padding: 8,
        color: WF.ink2,
        background: WF.paperAlt,
        border: `1px solid ${WF.rule}`,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        maxHeight: 320,
        overflow: 'auto',
      }}
    >{body}</pre>
  );
}

function fmtClock(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function fmtFullClock(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

function pad(n) { return String(n).padStart(2, '0'); }
