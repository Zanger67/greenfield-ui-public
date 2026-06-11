// Semantic areas — the third top-level screen, beside the dossier inbox and
// overview. Where the dossier walks commits one-by-one in time order and the
// overview rolls them up into auditor output, this screen groups commits by
// *idea*: each area is one suspicion's anchor commit plus the evidence commits
// it cites, which need NOT be adjacent in history (e.g. a bug introduced in
// commit 3, copied into 18, then fixed in 60 — one area, three scattered
// commits).
//
// Areas are derived in-UI by dataStore.deriveSemanticAreas: every non-dropped
// suspicion that links >=2 resolvable commits becomes an area (single-commit
// suspicions stay dossier-only flags), merged with any explicit clusters from an
// optional semantic_clusters.jsonl. Selecting an area shows commentary + reasoning
// and, below, an A→B→C progression: for every file touched anywhere across the
// area's commits, the chronological sequence of that file's states, each
// rendered as the diff that commit applied. Intermediate states are kept, so a
// file edited in three of the area's commits shows three diffs in order.
import React from 'react';
import {
  WF,
  inkBorder,
  L,
  Box,
  Chip,
  Check,
  CopyBlock,
  CopyTitle,
  refStatement,
  UI_HANDOFF_PREFIX,
  traceLocation,
  AppFrame,
  LoadingBox,
  PaneResizer,
  renderInline,
} from './primitives.jsx';
import { useData } from './dataStore.jsx';
import { ScreenTabs } from './App.jsx';
import { TopBarControls, Sha, TagFlagsHint, useSettings, useAnonymize } from './settings.jsx';
import { ValidatorNotesEditor } from './ValidatorNotes.jsx';
import { usergroupKey, TagEditor, useDescribeTarget, reverseTagIndex, pickGroupColor } from './Tagging.jsx';
import { parseDiff, FileDiff, ColoredDiffBody, SuspicionDetail, DiffGroup, CommitHeader, LogDiffTable, BIG_FILE_LINES, PREVIEW_LINES } from './WireDossierInbox.jsx';

// Markup overlays on areas/threads are keyed in the shared notes/flags maps
// under a namespaced id so they never collide with a chunk's event id.
const areaKey = (id) => `area:${id}`;
const threadKey = (id) => `thread:${id}`;

// A suspicion-area is the auditor's view of one suspicion, and that same
// suspicion is dismissed in the dossier inbox / overview by its *anchor commit's*
// chunk id (event_id) — never this `area:` key. So an area's dismissed state is
// derived from the anchor commit's dismissal: dismiss the suspicion in either
// place and it clears in both. Clusters (no suspicion, no home commit) keep their
// own `area:` key. Mirror this in the toggle below — write the anchor commit, not
// the area key, for suspicion-areas.
function isAreaDismissed(area, bySha, dismissedOverlay) {
  if (!area) return false;
  const anchor = area.suspicion_id ? bySha[area.anchor_sha] : null;
  if (anchor) return !!dismissedOverlay[anchor.id];
  return !!dismissedOverlay[areaKey(area.area_id)];
}

const nameParam = (n) => (n ? `&name=${encodeURIComponent(n)}` : '');

const FLAG_COLOR = { high: WF.heat4, medium: WF.heat3, mild: WF.heat2, low: WF.heat2 };
const flagColor = (level) => FLAG_COLOR[level] || WF.ink3;

// A, B, C … then #27, #28 … past the alphabet.
const stateLabel = (i) => (i < 26 ? String.fromCharCode(65 + i) : `#${i + 1}`);

// Decode an areaFocus deep-link token ("area:<id>" / "thread:<id>" /
// "usergroup:<id>") into a selection tuple. Returns null on an empty / malformed
// token; existence in the current trace is checked by the caller.
function parseFocus(token) {
  if (!token) return null;
  const sep = token.indexOf(':');
  if (sep <= 0 || sep === token.length - 1) return null;
  const kind = token.slice(0, sep);
  const id = token.slice(sep + 1);
  if (kind !== 'area' && kind !== 'thread' && kind !== 'usergroup') return null;
  return { kind, id };
}

export function WireSemanticAreas() {
  const { data, showAiSuspicion, openCommit, areaFocus, recordFocus, dismissedOverlay = {}, userGroupsOverlay = {} } = useData();
  // The auditor's own user groups lead the screen (the rail's top category).
  // Ordered by creation so the list is stable as groups are added.
  const userGroups = React.useMemo(
    () => Object.values(userGroupsOverlay).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)),
    [userGroupsOverlay],
  );
  // When the top-bar AI-flags pill is off (default), the data store has already
  // emptied `semanticAreas` — areas are derived entirely from the narrator's
  // suspicions, so there's nothing AI-neutral to show. Threads (a thread_agent
  // grouping, not a suspicion verdict) survive. `showAiSuspicion` is read so the
  // rail / empty state can explain the absence rather than look like a dead screen.
  const { semanticAreas: rawAreas = [], threads = [], coverage, bySha = {} } = data;
  const { paneWidths, setPaneWidth } = useSettings();
  // Dismissed areas sink to the back of the flagged list (the auditor cleared
  // them) while keeping their relative order; the live suspicions lead. A stable
  // partition, so re-default selection naturally lands on a non-dismissed area.
  // Dismissal is derived from the anchor commit (see isAreaDismissed), so a
  // dossier-inbox dismiss sinks the matching area here too.
  const semanticAreas = React.useMemo(() => {
    const live = [], cleared = [];
    for (const a of rawAreas) (isAreaDismissed(a, bySha, dismissedOverlay) ? cleared : live).push(a);
    return [...live, ...cleared];
  }, [rawAreas, bySha, dismissedOverlay]);
  // One selection across both sections: { kind: 'area' | 'thread', id }.
  // Initialise from any `areaFocus` deep-link the arriving render carries (e.g.
  // a flagged area clicked on the overview), so the focused item is selected
  // from the very first render rather than overwritten by the default-selection
  // effect — the two-effect handoff was order-dependent and StrictMode's dev
  // double-invoke could land us on the first item instead of the focused one.
  const [sel, setSel] = React.useState(() => parseFocus(areaFocus));
  const lastFocus = React.useRef(areaFocus || null);

  // A rail click both selects locally (snappy) and records the choice onto the
  // current history entry via recordFocus, so back/forward and reload restore it.
  // Before this, sel was local-only: leaving the screen unmounted it, and on
  // return it re-hydrated from the (stale) focus token and otherwise snapped to
  // the default first item. We set lastFocus up-front so the focus-sync effect
  // below sees its own value land and doesn't redundantly re-set sel.
  const selectItem = React.useCallback((next) => {
    setSel(next);
    const token = next ? `${next.kind}:${next.id}` : null;
    lastFocus.current = token;
    recordFocus(token);
  }, [recordFocus]);

  // Default to the first flagged area (then the first thread, then the first
  // user group); re-default when the current selection no longer exists (e.g.
  // after a trace swap, a deleted group, or when the arriving focus token didn't
  // resolve to anything in this trace).
  React.useEffect(() => {
    const exists = sel && (
      (sel.kind === 'area' && semanticAreas.some((a) => a.area_id === sel.id)) ||
      (sel.kind === 'thread' && threads.some((t) => t.thread_id === sel.id)) ||
      (sel.kind === 'usergroup' && userGroups.some((g) => g.id === sel.id))
    );
    if (exists) return;
    if (semanticAreas.length) setSel({ kind: 'area', id: semanticAreas[0].area_id });
    else if (threads.length) setSel({ kind: 'thread', id: threads[0].thread_id });
    else if (userGroups.length) setSel({ kind: 'usergroup', id: userGroups[0].id });
    else setSel(null);
  }, [semanticAreas, threads, userGroups, sel]);

  // Entry focus: another screen (e.g. a commit's thread link, or an overview
  // user-group row) deep-linked us to a specific item via the "kind:id" token.
  // Mount-time focus is handled by the useState init above; this effect catches
  // focus tokens that arrive later (browser back/forward, or a second deep-link
  // while we're still mounted).
  React.useEffect(() => {
    if (!areaFocus || areaFocus === lastFocus.current) return;
    const next = parseFocus(areaFocus);
    if (!next) return;
    if (next.kind === 'thread' && !threads.some((t) => t.thread_id === next.id)) return;
    if (next.kind === 'area' && !semanticAreas.some((a) => a.area_id === next.id)) return;
    if (next.kind === 'usergroup' && !userGroups.some((g) => g.id === next.id)) return;
    lastFocus.current = areaFocus;
    setSel(next);
  }, [areaFocus, threads, semanticAreas, userGroups]);

  const area = sel?.kind === 'area' ? semanticAreas.find((a) => a.area_id === sel.id) : null;
  const thread = sel?.kind === 'thread' ? threads.find((t) => t.thread_id === sel.id) : null;
  const userGroup = sel?.kind === 'usergroup' ? userGroups.find((g) => g.id === sel.id) : null;
  const hasDetail = !!(area || thread || userGroup);

  return (
    <AppFrame
      topBar={<ScreenTabs />}
      subtitle={[
        `${userGroups.length} group${userGroups.length === 1 ? '' : 's'}`,
        showAiSuspicion && `${semanticAreas.length} AI flagged`,
        `${threads.length} thread${threads.length === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' · ')}
      coverageProps={{ ...coverage, showSuspicion: showAiSuspicion }}
      rightSlot={<TopBarControls />}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <Sidebar areas={semanticAreas} threads={threads} userGroups={userGroups} sel={sel} onSelect={selectItem} width={paneWidths.areasSidebar} showAiSuspicion={showAiSuspicion} />
        <PaneResizer
          width={paneWidths.areasSidebar}
          setWidth={(w) => setPaneWidth('areasSidebar', w)}
          min={240}
          max={640}
          dflt={360}
          dir={1}
        />
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {area ? <AreaDetail area={area} onOpenCommit={openCommit} />
            : thread ? <ThreadDetail thread={thread} onOpenCommit={openCommit} />
            : userGroup ? <UserGroupDetail group={userGroup} />
            : <Empty showAiSuspicion={showAiSuspicion} />}
        </div>
        {hasDetail && (
          <PaneResizer
            width={paneWidths.auditorPanel}
            setWidth={(w) => setPaneWidth('auditorPanel', w)}
            min={240}
            max={560}
            dflt={320}
            dir={-1}
          />
        )}
        {area && <AuditorPanel targetKey={areaKey(area.area_id)} noun="area" width={paneWidths.auditorPanel} />}
        {thread && <AuditorPanel targetKey={threadKey(thread.thread_id)} noun="thread" width={paneWidths.auditorPanel} />}
        {/* A user group's own annotations live under its `usergroup:` key;
            tagging is disabled here (a group can't be tagged into a group) and so
            is the flag (showFlag={false}) — a group is built *from* flagged items,
            so a flag on the group itself would be redundant. */}
        {userGroup && <AuditorPanel targetKey={usergroupKey(userGroup.id)} noun="group" width={paneWidths.auditorPanel} showTags={false} showFlag={false} />}
      </div>
    </AppFrame>
  );
}

function Empty({ showAiSuspicion }) {
  return (
    <div style={{ padding: 40 }}>
      <L mono size={12} color={WF.ink3}>
        {showAiSuspicion
          ? `Nothing here yet. A flagged area is a suspicion that links two or more
             commits; a thread is a line of work identified by the thread_agent. This
             trace has neither (run the suspicion / thread agents to populate them).`
          : `AI suspicion flagging is off. Flagged areas are derived from the
             narrator's suspicions, so they're hidden until you turn AI flags on
             (the pill in the top bar). Threads, when present, still show.`}
      </L>
    </div>
  );
}

// Coarse theme → accent colour for thread items (open set; default is neutral).
const THEME_COLOR = {
  data: WF.catData, training: WF.catBlue, evaluation: WF.catBlue, grading: WF.catPurple,
  analysis: WF.catPurple, plotting: WF.catAmber, infra: WF.catSlate, cleanup: WF.catBlueGrey,
};
const themeColor = (t) => THEME_COLOR[t] || WF.ink2;

// Left rail: the auditor's own user groups lead (the "category for user groups
// at the top"), then flagged areas (from suspicions), then semantic threads
// (from the thread_agent).
function Sidebar({ areas, threads, userGroups, sel, onSelect, width = 360, showAiSuspicion = true }) {
  const anon = useAnonymize();
  const { data, flaggedOverlay = {}, dismissedOverlay = {} } = useData();
  const { bySha = {} } = data;
  // Each rail section collapses independently by clicking its head; the caret in
  // RailHead reflects the state. Collapsed sections keep their head (and count)
  // visible so the auditor can still see how much is hidden behind each.
  const [collapsed, setCollapsed] = React.useState({ groups: false, areas: false, threads: false });
  const toggle = (k) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));
  return (
    <div style={{ width, overflow: 'auto', flexShrink: 0 }}>
      <UserGroupRail userGroups={userGroups} sel={sel} onSelect={onSelect} collapsed={collapsed.groups} onToggle={() => toggle('groups')} />

      {/* Flagged areas are AI-derived (narrator suspicions), so the whole
          section — head and all — is hidden while AI flags are off rather than
          showing an empty rail with an explanatory hint. */}
      {showAiSuspicion && <>
      <RailHead label="flagged areas" count={areas.length} collapsed={collapsed.areas} onToggle={() => toggle('areas')} />
      {!collapsed.areas && areas.length === 0 && <RailHint text="no multi-commit suspicions" />}
      {!collapsed.areas && areas.map((a) => {
        const dismissed = isAreaDismissed(a, bySha, dismissedOverlay);
        // Dismissed areas desaturate their left-rail accent (heat → muted ink)
        // and dim, so the cleared ones at the back read as demoted at a glance.
        const accent = dismissed ? WF.rule2 : flagColor(a.flag_level);
        return (
        <button
          key={a.area_id}
          onClick={() => onSelect({ kind: 'area', id: a.area_id })}
          style={{ ...railBtn(accent, sel?.kind === 'area' && sel.id === a.area_id), opacity: dismissed ? 0.62 : 1 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Chip bg={dismissed ? WF.heat2 : flagColor(a.flag_level)} color={WF.onAccent}>{a.flag_level}</Chip>
            <Chip>{a.category}</Chip>
            {dismissed && <Chip bg={WF.paperAlt} color={WF.ink2}>dismissed</Chip>}
            {flaggedOverlay[areaKey(a.area_id)] && <RailFlag />}
            <div style={{ flex: 1 }} />
            <L mono size={10} color={WF.ink3}>{(a.commit_shas || []).length} commits</L>
          </div>
          <L size={13} weight={600}>{anon(a.title)}</L>
          <L mono size={10} color={WF.ink3}>{anon(a.agent_id)}{a.reviewed_by_opus ? ' · opus✓' : ''}</L>
        </button>
        );
      })}
      </>}

      <RailHead label="semantic threads" count={threads.length} collapsed={collapsed.threads} onToggle={() => toggle('threads')} />
      {!collapsed.threads && threads.length === 0 && <RailHint text="no thread annotations (run thread_agent)" />}
      {!collapsed.threads && threads.map((t) => (
        <button
          key={t.thread_id}
          onClick={() => onSelect({ kind: 'thread', id: t.thread_id })}
          style={railBtn(themeColor(t.theme), sel?.kind === 'thread' && sel.id === t.thread_id)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Chip bg={themeColor(t.theme)} color={WF.onAccent}>🧵 {t.theme}</Chip>
            {flaggedOverlay[threadKey(t.thread_id)] && <RailFlag />}
            <div style={{ flex: 1 }} />
            <L mono size={10} color={WF.ink3}>{t.commit_shas.length} commits</L>
          </div>
          <L size={13} weight={600}>{anon(t.label)}</L>
        </button>
      ))}
    </div>
  );
}

// The top rail category: the auditor's own user groups. Each lists its member
// count (across commits / groups / areas / threads / docs) and how many
// annotations it carries; the trailing row creates a new empty group, which the
// auditor can then tag items into. Member/annotation/flag state is read live
// from the overlays so the rail tracks tagging done anywhere in the app.
function UserGroupRail({ userGroups, sel, onSelect, collapsed = false, onToggle }) {
  const { groupTagsOverlay = {}, flaggedOverlay = {}, userNotesOverlay = {}, createUserGroup } = useData();
  const memberIndex = React.useMemo(() => reverseTagIndex(groupTagsOverlay), [groupTagsOverlay]);
  return (
    <>
      <RailHead label="user groups" count={userGroups.length} collapsed={collapsed} onToggle={onToggle} />
      {!collapsed && userGroups.length === 0 && (
        <RailHint text="no groups yet — flag an item and tag it into a group, or add one below" />
      )}
      {!collapsed && userGroups.map((g) => {
        const members = memberIndex[g.id] || [];
        const notes = userNotesOverlay[usergroupKey(g.id)] || [];
        const flagged = !!flaggedOverlay[usergroupKey(g.id)];
        const active = sel?.kind === 'usergroup' && sel.id === g.id;
        return (
          <button
            key={g.id}
            onClick={() => onSelect({ kind: 'usergroup', id: g.id })}
            style={railBtn(g.color || WF.ink2, active)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ width: 10, height: 10, background: g.color || WF.ink2, border: `1px solid ${WF.ink}` }} />
              <Chip>group</Chip>
              {flagged && <RailFlag />}
              <div style={{ flex: 1 }} />
              <L mono size={10} color={WF.ink3}>{members.length} item{members.length === 1 ? '' : 's'}</L>
            </div>
            <L size={13} weight={600}>{g.name}</L>
            {notes.length > 0 && <L mono size={10} color={WF.ink3}>{notes.length} annotation{notes.length === 1 ? '' : 's'}</L>}
          </button>
        );
      })}
      {!collapsed && <NewGroupRow onCreate={(name) => {
        const id = createUserGroup(name, pickGroupColor(userGroups.length));
        if (id) onSelect({ kind: 'usergroup', id });
      }} />}
    </>
  );
}

// Inline "create a group" row at the foot of the user-groups rail — type a name,
// Enter to create it and select it for annotating.
function NewGroupRow({ onCreate }) {
  const [name, setName] = React.useState('');
  const submit = () => { const n = name.trim(); if (!n) return; onCreate(n); setName(''); };
  return (
    <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: `1px solid ${WF.rule}`, alignItems: 'center' }}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder="new group name…"
        style={{ flex: 1, minWidth: 0, fontFamily: WF.monoFont, fontSize: 12, padding: '4px 6px', border: inkBorder(1.2), background: WF.paper, color: WF.ink }}
      />
    </div>
  );
}

// The auditor's own flag, shown in the rail so a hand-flagged area / thread /
// group reads as suspicious at a glance — independent of any agent level.
function RailFlag() {
  return <Chip bg={WF.heat4} color={WF.onAccent} style={{ fontWeight: 700 }}>⚑</Chip>;
}

const railBtn = (accent, active) => ({
  textAlign: 'left', border: 'none', borderBottom: `1px solid ${WF.rule}`,
  borderLeft: `6px solid ${accent}`, background: active ? WF.paperAlt : WF.paper,
  padding: '10px 12px', cursor: 'pointer', display: 'flex', flexDirection: 'column',
  gap: 4, width: '100%',
});

function RailHead({ label, count, collapsed, onToggle }) {
  const clickable = !!onToggle;
  return (
    <div
      onClick={onToggle}
      title={clickable ? (collapsed ? `show ${label}` : `collapse ${label}`) : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        background: WF.paperAlt, borderBottom: inkBorder(), borderTop: inkBorder(), position: 'sticky', top: 0,
        cursor: clickable ? 'pointer' : 'default', userSelect: 'none',
      }}
    >
      {clickable && (
        <L mono size={9} color={WF.ink3} style={{ width: 9, textAlign: 'center' }}>{collapsed ? '▶' : '▼'}</L>
      )}
      <L size={11} weight={700} color={WF.ink2} style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</L>
      <Chip>{count}</Chip>
    </div>
  );
}

function RailHint({ text }) {
  return <L mono size={11} color={WF.ink3} style={{ display: 'block', padding: 16 }}>{text}</L>;
}

function AreaDetail({ area, onOpenCommit }) {
  const { data, dismissedOverlay = {}, setDismissed, currentTrace } = useData();
  const anon = useAnonymize();
  const { bySha = {} } = data;
  const dismissed = isAreaDismissed(area, bySha, dismissedOverlay);
  // Cascade keys: every linked commit that *itself* carries an agent suspicion.
  // Dismissing the area is a verdict on the cluster, so the dossier inbox and
  // overview see the same cleared state for those commits — and, because a
  // suspicion-area's dismissed state is read off its anchor commit, dismissing
  // here is the exact inverse of dismissing that commit in the dossier. Linked
  // commits with no flagLevel of their own stay untouched — no suspicion to
  // dismiss. (The anchor always carries the suspicion, so it's in this set.)
  const linkedCommitIds = React.useMemo(() => {
    const ids = [];
    for (const sha of area.commit_shas || []) {
      const c = bySha[sha];
      if (c && c.flagLevel) ids.push(c.id);
    }
    return ids;
  }, [area, bySha]);
  // Suspicion-areas flip the anchor commit (so the dossier/overview match);
  // anchorless clusters fall back to their own `area:` key. Either way the linked
  // flagged members come along.
  const anchorChunk = area.suspicion_id ? bySha[area.anchor_sha] : null;
  const toggle = () => {
    const keys = anchorChunk
      ? Array.from(new Set([anchorChunk.id, ...linkedCommitIds]))
      : [areaKey(area.area_id), ...linkedCommitIds];
    setDismissed(keys, !dismissed);
  };
  return (
    <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1100, opacity: dismissed ? 0.78 : 1 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Chip bg={dismissed ? WF.heat2 : flagColor(area.flag_level)} color={WF.onAccent} style={{ fontSize: 13, padding: '4px 9px' }}>
            {area.flag_level}
          </Chip>
          <Chip style={{ fontSize: 12 }}>{area.category}</Chip>
          <Chip style={{ fontSize: 12 }}>intent: {anon(area.intent_hypothesis)}</Chip>
          <L mono size={11} color={WF.ink3}>{anon(area.agent_id)}</L>
          {area.reviewed_by_opus && <Chip>opus reviewed</Chip>}
          {dismissed && <Chip bg={WF.paperAlt} color={WF.ink2}>dismissed</Chip>}
          <div style={{ flex: 1 }} />
          <Chip
            onClick={toggle}
            style={{ cursor: 'pointer', background: dismissed ? WF.paper : WF.paperAlt, color: WF.ink2 }}
            title={dismissed
              ? `restore this area${linkedCommitIds.length ? ` and its ${linkedCommitIds.length} linked flagged commit${linkedCommitIds.length === 1 ? '' : 's'}` : ''}`
              : `dismiss: I looked, this is fine — sinks to the back${linkedCommitIds.length ? `, also dismisses ${linkedCommitIds.length} linked flagged commit${linkedCommitIds.length === 1 ? '' : 's'}` : ''}`}
          >{dismissed ? '↩ restore' : '✕ dismiss'}</Chip>
        </div>
        <CopyTitle
          size={18}
          style={{ marginTop: 8 }}
          copyText={refStatement({ kind: 'area', label: area.title, targetKey: `area:${area.area_id}`, trace: currentTrace })}
        >{anon(area.title)}</CopyTitle>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {area.commentary && (
          <div style={{ flex: '2 1 360px', minWidth: 280 }}>
            <TextBlock label="commentary" text={area.commentary} />
          </div>
        )}
        <CopyBlock
          size={10.5}
          italic
          style={{ flex: '1 1 240px', minWidth: 230 }}
          text={`${UI_HANDOFF_PREFIX}${traceLocation(currentTrace)}Investigate the flagged area "${area.title}" — audit pointer area:${area.area_id}. Resolve it via the schema in the UI's AGENTS.md.`}
        />
      </div>
      <TextBlock label="reasoning" text={area.reasoning} accent={WF.heat4} />
      {area.opus_addendum && <TextBlock label="opus addendum" text={area.opus_addendum} accent={WF.ink2} />}

      <MemberSuspicionsSummary shas={area.commit_shas || []} />
      <CommitStrip shas={area.commit_shas || []} onOpenCommit={onOpenCommit} />
      <AreaProgression shas={area.commit_shas || []} />
    </div>
  );
}

// Detail for a selected thread: the subagent's direction + reasoning, then the
// thread walked *commit by commit* — each commit's full diff rendered whole (the
// same holistic view the dossier gives one commit), with the thread_agent's beat
// note for that commit shown inline above it. Unlike an area (which pivots each
// file's states across the commits), a thread reads as an ordered sequence of
// commits, so it does not follow one file through them. This view is the
// thread_agent's output only — no suspicion-agent flags are mixed in here.
function ThreadDetail({ thread, onOpenCommit }) {
  const { currentTrace } = useData();
  const anon = useAnonymize();
  const accent = themeColor(thread.theme);
  return (
    <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1100 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Chip bg={accent} color={WF.onAccent} style={{ fontSize: 13, padding: '4px 9px' }}>🧵 thread</Chip>
          <Chip style={{ fontSize: 12 }}>{thread.theme}</Chip>
          <L mono size={11} color={WF.ink3}>{thread.thread_id}</L>
        </div>
        <CopyTitle
          size={18}
          style={{ marginTop: 8 }}
          copyText={refStatement({ kind: 'thread', label: thread.label, targetKey: `thread:${thread.thread_id}`, trace: currentTrace })}
        >{anon(thread.label)}</CopyTitle>
      </div>

      <CopyBlock
        size={10.5}
        italic
        text={`${UI_HANDOFF_PREFIX}${traceLocation(currentTrace)}Investigate the semantic thread "${thread.label}" — audit pointer thread:${thread.thread_id}. Resolve it via the schema in the UI's AGENTS.md.`}
      />

      <TextBlock label="direction" text={thread.direction} accent={accent} />
      <TextBlock label="potential reasoning" text={thread.reasoning} accent={WF.ink2} />

      <ThreadProgression
        shas={thread.commit_shas || []}
        beats={thread.beats || {}}
        accent={accent}
        onOpenCommit={onOpenCommit}
      />
    </div>
  );
}

// Walk a thread commit by commit. Each commit's `git show` is fetched and parsed,
// then rendered whole — source files (DiffGroup), commit message, and log
// artifacts (LogDiffTable) — exactly the dossier's single-commit layout, so a
// thread commit looks the same opened here or in the inbox. Above each commit's
// diff sits its thread beat note when one exists: the thread_agent's sidecar
// annotation keyed by commit sha (thread.beats). Beats are optional per commit
// (a thread can list a commit with no beat); the diff still renders. Each commit
// card folds (default open) so a long thread — some run 20+ commits — stays
// scannable by its beats once the auditor has read a commit's diff.
function ThreadProgression({ shas, beats = {}, accent = WF.heat3, onOpenCommit, title = 'commit by commit', hint }) {
  const { selectedInput } = useData();
  const [state, setState] = React.useState({ status: 'idle', commits: [], error: null });

  React.useEffect(() => {
    if (!shas || shas.length === 0) { setState({ status: 'empty', commits: [], error: null }); return undefined; }
    let cancelled = false;
    setState({ status: 'loading', commits: [], error: null });

    Promise.all(shas.map(async (sha) => {
      const r = await fetch(`/api/diff?sha=${encodeURIComponent(sha)}${nameParam(selectedInput)}`);
      const text = await r.text();
      if (!r.ok) throw new Error(text || `HTTP ${r.status}`);
      return { sha, parsed: parseDiff(text) };
    }))
      .then((commits) => { if (!cancelled) setState({ status: 'ready', commits, error: null }); })
      .catch((err) => { if (!cancelled) setState({ status: 'error', commits: [], error: err.message }); });

    return () => { cancelled = true; };
  }, [shas, selectedInput]);

  const withBeats = React.useMemo(
    () => (shas || []).reduce((n, sha) => n + (beats[sha] ? 1 : 0), 0),
    [shas, beats],
  );

  return (
    <section>
      <SectionHead
        title={title}
        count={shas.length}
        hint={hint != null ? hint : `each commit's full diff, in order · ${withBeats} with a thread note`}
        accent={accent}
      />
      {state.status === 'loading' && (
        <LoadingBox label={`loading ${shas.length} commit diff${shas.length === 1 ? '' : 's'}`} height={64} style={{ marginTop: 8 }} />
      )}
      {state.status === 'error' && <L mono size={11} color={WF.heat4}>error: {state.error}</L>}
      {state.status === 'ready' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {state.commits.map(({ sha, parsed }, i) => (
            <ThreadCommit
              key={sha}
              sha={sha}
              parsed={parsed}
              index={i}
              total={shas.length}
              note={beats[sha] || ''}
              accent={accent}
              onOpenCommit={onOpenCommit}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// One commit in a thread: a header strip (state label, sha, kind, title, a
// deep-link into the dossier), the thread beat note when present, and the
// commit's whole diff. The diff body folds from the header so a reviewed commit
// collapses to its beat line.
function ThreadCommit({ sha, parsed, index, total, note, accent = WF.heat3, onOpenCommit }) {
  const { data } = useData();
  const anon = useAnonymize();
  const { bySha = {}, byId = {} } = data;
  const stub = bySha[sha];
  const chunk = stub ? (byId[stub.id] || stub) : null;
  const [open, setOpen] = React.useState(true);
  const hasDiff = parsed.other.length > 0 || parsed.logs.length > 0;
  return (
    <Box style={{ padding: 0, overflow: 'hidden' }}>
      <div
        onClick={() => setOpen((v) => !v)}
        title={open ? 'collapse this commit’s diff' : 'expand this commit’s diff'}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: WF.paperAlt, borderBottom: open || note ? inkBorder() : 'none', cursor: 'pointer', userSelect: 'none' }}
      >
        <L mono size={11} color={WF.ink2} style={{ width: 12, textAlign: 'center' }}>{open ? '▾' : '▸'}</L>
        <Chip bg={WF.ink} color={WF.paper}>{stateLabel(index)}</Chip>
        <Sha sha={sha} size={13} weight={700} />
        {chunk && <Chip>{chunk.kind}</Chip>}
        {chunk?.file && <L mono size={11} color={WF.ink2}>{anon(chunk.file)}</L>}
        <L size={12} color={WF.ink2} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {chunk ? anon(chunk.title) : '(commit not in this trace’s event map)'}
        </L>
        <L mono size={10} color={WF.ink3}>commit {index + 1} of {total}</L>
        {chunk && onOpenCommit && (
          <L
            mono
            size={11}
            color={WF.ink3}
            onClick={(e) => { e.stopPropagation(); onOpenCommit(chunk.id); }}
            title="open this commit in the dossier inbox"
            style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 2 }}
          >open →</L>
        )}
      </div>

      {note && <ThreadBeat note={note} accent={accent} />}

      {open && (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {parsed.other.length > 0 && (
            <DiffGroup accent={WF.ink} files={parsed.other} sha={sha} hideHeader />
          )}
          {parsed.commitMessage && <CommitHeader text={parsed.commitMessage} />}
          {parsed.logs.length > 0 && (
            <LogDiffTable files={parsed.logs} hint="trace artifacts updated by this commit" />
          )}
          {!hasDiff && <L mono size={11} color={WF.ink3}>no file changes (commit metadata only)</L>}
        </div>
      )}
    </Box>
  );
}

// The thread_agent's beat note for one commit — the thread's sidecar annotation,
// keyed by commit sha. Themed with the thread's accent and tagged so it reads as
// the threading agent's voice, distinct from the diff below and from any
// suspicion-agent flag (which this thread view deliberately does not surface).
function ThreadBeat({ note, accent = WF.heat3 }) {
  const anon = useAnonymize();
  return (
    <div style={{ padding: '10px 12px', borderLeft: `5px solid ${accent}`, background: WF.paper }}>
      <L size={10} weight={700} color={WF.ink3} style={{ display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>🧵 thread note</L>
      <L size={12.5} color={WF.ink2} style={{ display: 'block', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{renderInline(anon(note))}</L>
    </div>
  );
}

// The auditor's own overlay on a flagged area or a thread: a flag toggle plus
// free-text validator notes, both keyed by the namespaced target id so they
// persist (per-trace, in localStorage) alongside the dossier's per-commit
// markups. The flag is the auditor's verdict — distinct from a thread's neutral
// theme or an area's pre-computed suspicion flag_level — and lets a "thread of
// suspicion" be raised even when no agent flagged it. Lives as a fixed right
// sidebar so the verdict stays put while the auditor scrolls the area body.
// Generic over `targetKey` (any overlay key — `area:`/`thread:`/`doc:`…) and
// `noun`, so other screens (e.g. the results screen) reuse it verbatim. When the
// target is flagged it also surfaces the group tag editor (`showTags`, default
// on) so the auditor can drop the flagged item into a user group from here; a
// user group's *own* panel passes showTags={false} (a group can't be tagged into
// a group) and showFlag={false} (a group is built from flagged items, so flagging
// the group itself is redundant).
export function AuditorPanel({ targetKey, noun, width = 320, showTags = true, showFlag = true }) {
  const { userNotesOverlay = {}, flaggedOverlay = {}, toggleFlag } = useData();
  const flagged = !!flaggedOverlay[targetKey];
  const notes = userNotesOverlay[targetKey] || [];
  return (
    <aside style={{
      width, flexShrink: 0, background: WF.paperAlt,
      display: 'flex', flexDirection: 'column', minHeight: 0,
    }}>
      <div style={{ padding: 14, borderBottom: inkBorder(), display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 12, height: 12, background: WF.heat4, border: inkBorder() }} />
        <L size={15} weight={700}>auditor</L>
      </div>
      <div style={{ padding: 14, flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Flag + grouping sit below the auditor header; grouping shows by default
            (like the dossier) so tagging is one click away whether or not the item
            is already flagged, and adding a tag flags it. A user group hides both
            (showFlag/showTags={false}), so the whole block is skipped when neither
            shows rather than leaving an empty gap above the notes. */}
        {(showFlag || showTags) && (
        <div>
          {showFlag && (
            <Chip
              onClick={() => toggleFlag(targetKey)}
              style={{ display: 'flex', justifyContent: 'center', width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontWeight: 700 }}
              bg={flagged ? WF.heat4 : 'transparent'}
              color={flagged ? WF.paper : WF.ink}
              title={flagged ? `remove your flag on this ${noun}` : `flag this ${noun} for review`}
            >
              {flagged ? '[!] flagged' : `[ ] flag ${noun}`}
            </Chip>
          )}
          {showTags && (
            <div style={{ marginTop: showFlag ? 10 : 0 }}>
              <TagEditor targetKey={targetKey} placeholder="enter tag…" />
              <TagFlagsHint noun={noun} style={{ marginTop: 6 }} />
            </div>
          )}
        </div>
        )}
        <div>
          <L size={11} weight={700} color={WF.ink3} style={{ display: 'block', marginBottom: 8 }}>validator notes (you)</L>
          <ValidatorNotesEditor chunkId={targetKey} notes={notes} placeholder={`add a note on this ${noun} …`} />
        </div>
      </div>
    </aside>
  );
}

// Resolve a membership target key to the underlying commit chunks it covers, so
// the group can surface the agent-authored comments on those commits. A commit
// key is itself one commit; a sidecar group / flagged area / thread expands to
// the commits it spans; a doc / nested user group contributes none.
function commitsForMemberKey(key, src) {
  const { byId = {}, bySha = {}, chunks = [], semanticAreas = [], threads = [] } = src;
  const colon = key.indexOf(':');
  const prefix = colon > 0 ? key.slice(0, colon) : '';
  const rest = colon > 0 ? key.slice(colon + 1) : key;
  if (prefix === 'group') return chunks.filter((c) => c.groupId === rest);
  if (prefix === 'area') {
    const a = semanticAreas.find((x) => x.area_id === rest);
    return (a?.commit_shas || []).map((s) => bySha[s]).filter(Boolean);
  }
  if (prefix === 'thread') {
    const t = threads.find((x) => x.thread_id === rest);
    return (t?.commit_shas || []).map((s) => bySha[s]).filter(Boolean);
  }
  if (prefix === 'doc' || prefix === 'usergroup') return [];
  const c = byId[key];
  return c ? [c] : [];
}

// Every annotation-agent and thread-agent comment attached to a group's members.
// Annotation-agent = the per-commit "what is being done" notes (+ any group-level
// ones); thread-agent = the per-commit beat notes, plus a thread member's
// direction / reasoning. Deduped across members (a commit can be reached more
// than one way) and ordered chronologically by commit index.
function collectGroupAgentComments(memberKeys, src) {
  const { bySha = {}, threads = [], annotationsByGroup = {} } = src;
  const annotation = [];
  const thread = [];
  const seenA = new Set();
  const seenT = new Set();
  const ord = (sha) => (sha && bySha[sha] ? bySha[sha].index : Number.MAX_SAFE_INTEGER);

  for (const key of memberKeys) {
    if (key.startsWith('group:')) {
      const gid = key.slice('group:'.length);
      for (const a of (annotationsByGroup[gid] || [])) {
        const text = a.annotation || '';
        if (!text) continue;
        const k = `g:${gid}:${text}`;
        if (seenA.has(k)) continue; seenA.add(k);
        annotation.push({ scope: 'group', title: a.short_title || '', text, sha: null, id: null, file: null });
      }
    }
    if (key.startsWith('thread:')) {
      const t = threads.find((x) => x.thread_id === key.slice('thread:'.length));
      if (t) {
        if (t.direction && !seenT.has(`td:${t.thread_id}`)) { seenT.add(`td:${t.thread_id}`); thread.push({ scope: 'thread', label: `${t.label} · direction`, text: t.direction, sha: null, id: null, file: null }); }
        if (t.reasoning && !seenT.has(`tr:${t.thread_id}`)) { seenT.add(`tr:${t.thread_id}`); thread.push({ scope: 'thread', label: `${t.label} · reasoning`, text: t.reasoning, sha: null, id: null, file: null }); }
      }
    }
    for (const c of commitsForMemberKey(key, src)) {
      for (const a of (c.annotations || [])) {
        const text = a.annotation || '';
        if (!text) continue;
        const k = `${c.sha || c.id}:${text}`;
        if (seenA.has(k)) continue; seenA.add(k);
        annotation.push({ scope: 'commit', title: a.short_title || '', text, sha: c.sha, id: c.id, file: c.file });
      }
      for (const th of (c.threads || [])) {
        if (!th.note) continue;
        const k = `${c.sha || c.id}:${th.thread_id}:${th.note}`;
        if (seenT.has(k)) continue; seenT.add(k);
        thread.push({ scope: 'commit', label: th.label || 'thread', text: th.note, sha: c.sha, id: c.id, file: c.file });
      }
    }
  }
  annotation.sort((a, b) => ord(a.sha) - ord(b.sha));
  thread.sort((a, b) => ord(a.sha) - ord(b.sha));
  return { annotation, thread };
}

// One row in a user group's "members" list. Shows the tagged item with its
// category chip (commit / group / thread / area / doc / plot). When the item is
// a container — a sidecar group, flagged area, or thread — the commits it
// resolves to are listed underneath as smaller sub-rows, each tagged with its
// commit type (MODIFY / BASH / CREATE / …) and file. This puts the whole roster
// in place under one header, so no separate "commits involved" section is needed.
function UserGroupMemberRow({ memberKey, groupId, describe, src, onUntag, onOpenCommit }) {
  const anon = useAnonymize();
  const d = describe(memberKey);
  if (!d) return null;
  const clickable = d.exists && d.open;
  const colon = memberKey.indexOf(':');
  const prefix = colon > 0 ? memberKey.slice(0, colon) : '';
  const isContainer = prefix === 'group' || prefix === 'area' || prefix === 'thread';
  // Resolve each covered commit through byId so the sub-row shows the live
  // visited / user-flag overlay (commitsForMemberKey can hand back pre-overlay
  // stubs for area / thread members).
  const subCommits = (isContainer ? commitsForMemberKey(memberKey, src) : []).map((c) => src.byId?.[c.id] || c);
  return (
    <Box style={{ padding: 0, opacity: d.exists ? 1 : 0.6 }}>
      <div
        onClick={clickable ? d.open : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', cursor: clickable ? 'pointer' : 'default' }}
      >
        <L mono size={12} color={WF.ink3} style={{ width: 14, textAlign: 'center' }}>{d.icon}</L>
        <Chip>{d.kind}</Chip>
        <L size={13} weight={600} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{anon(d.label)}</L>
        <L mono size={10} color={WF.ink3}>{isContainer ? `${subCommits.length} commit${subCommits.length === 1 ? '' : 's'}` : anon(d.sublabel)}</L>
        {clickable && <L mono size={11} color={WF.ink3}>→</L>}
        <Chip
          onClick={(e) => { e.stopPropagation(); onUntag(memberKey, groupId); }}
          style={{ cursor: 'pointer', background: WF.paper }}
          title="remove this item from the group"
        >×</Chip>
      </div>
      {subCommits.length > 0 && (
        <div style={{ borderTop: `1px solid ${WF.rule}`, padding: '4px 10px 6px 34px', display: 'flex', flexDirection: 'column' }}>
          {subCommits.map((c) => (
            <div
              key={c.id}
              onClick={(e) => { e.stopPropagation(); onOpenCommit(c.id); }}
              title="open this commit in the dossier inbox"
              style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 8, alignItems: 'baseline', padding: '2px 0', cursor: 'pointer' }}
            >
              <Chip style={{ background: WF.paperAlt, color: WF.ink2 }} title="commit type">{c.kindLabel || c.kind}</Chip>
              <L mono size={11} color={WF.ink2} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{anon(c.file || c.title)}</L>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {c.userFlagged && <L mono size={10} color={WF.heat4} title="you flagged this commit">⚑</L>}
                <Sha sha={c.sha} size={10} color={WF.ink3} />
                <Check on={c.visited} />
              </span>
            </div>
          ))}
        </div>
      )}
    </Box>
  );
}

// Detail pane for a selected user group: a rename field + delete, the member
// list, every auditor comment the group + its members carry (consolidated for
// one read of the theme), and a collapsed-by-default dropdown of the
// agent-generated commentary (annotation + thread agents) for those members. The
// group's own annotation is still added/edited in the right-hand AuditorPanel
// (under the `usergroup:` key); this view also surfaces it read-only alongside
// the member notes.
function UserGroupDetail({ group }) {
  const { data, rawData, selectedInput, currentTrace, groupTagsOverlay = {}, userNotesOverlay = {}, renameUserGroup, deleteUserGroup, untagTarget, openCommit } = useData();
  const anon = useAnonymize();
  const describe = useDescribeTarget();
  // Resolve against the ungated data so areas / annotations / threads are found
  // even when the AI-flags toggle has emptied them out of `data`.
  const src = rawData || data || {};
  const [name, setName] = React.useState(group.name);
  const [armed, setArmed] = React.useState(false);
  // Re-seed the rename field + disarm delete when the selection changes group.
  React.useEffect(() => { setName(group.name); setArmed(false); }, [group.id, group.name]);
  const commitName = () => { const n = name.trim(); if (n && n !== group.name) renameUserGroup(group.id, n); else setName(group.name); };

  const memberKeys = React.useMemo(() => (reverseTagIndex(groupTagsOverlay)[group.id] || []), [groupTagsOverlay, group.id]);

  // All auditor comments for the theme: the group's own annotations first, then
  // every member's validator notes, each tagged with the item it sits on.
  const auditorComments = React.useMemo(() => {
    const out = [];
    for (const note of (userNotesOverlay[usergroupKey(group.id)] || [])) {
      out.push({ key: usergroupKey(group.id), kind: 'group note', label: group.name, open: null, note });
    }
    for (const key of memberKeys) {
      const notes = userNotesOverlay[key] || [];
      if (notes.length === 0) continue;
      const d = describe(key);
      for (const note of notes) {
        out.push({ key, kind: d?.kind || 'item', label: d?.label || key, open: d?.exists ? d.open : null, note });
      }
    }
    return out;
  }, [group.id, group.name, memberKeys, userNotesOverlay, describe]);

  const agentComments = React.useMemo(() => collectGroupAgentComments(memberKeys, src), [memberKeys, src]);

  // The document / plot members (final-report docs, pngs) — surfaced first, in
  // their own collapsed dropdown, ahead of the commit diff timeline.
  const docPlotKeys = React.useMemo(
    () => memberKeys.filter((k) => k.startsWith('doc:') || k.startsWith('plot:')),
    [memberKeys],
  );

  // Every commit the group's members cover, deduped by sha and ordered
  // chronologically — a directly-tagged commit contributes itself; a tagged
  // sidecar group / flagged area / thread expands to every commit it spans.
  // Resolved through byId so each chunk carries the live visited / user-flag
  // overlay (bySha holds pre-overlay stubs). This is the spine for the diff
  // timeline below; the per-member commit breakdown now lives inline in the
  // "members" list above (each container expands underneath itself).
  const compiledShas = React.useMemo(() => {
    const byKey = new Map();
    for (const key of memberKeys) {
      for (const stub of commitsForMemberKey(key, src)) {
        if (!stub?.sha) continue;
        const chunk = src.byId?.[stub.id] || stub;
        if (!byKey.has(chunk.sha)) byKey.set(chunk.sha, chunk);
      }
    }
    return [...byKey.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((c) => c.sha);
  }, [memberKeys, src]);

  // One-glance scope for the group handoff prompt: what kinds of items the auditor
  // tagged (its "type" — a user group is heterogeneous), then the commit count its
  // members transitively span. Pre-computes what AGENTS.md's "confirm scope first"
  // step asks the agent to echo back. No first…last sha range: a user group's
  // members aren't guaranteed to be consecutive commits (unlike a timeline/sidecar
  // group), so a sha range would imply an adjacency that isn't there — the count
  // alone is accurate. Same reasoning keeps the thread / area prompts range-free.
  const groupScope = React.useMemo(() => {
    const order = ['commit', 'group', 'area', 'thread', 'doc', 'plot'];
    const noun = { commit: 'commit', group: 'sidecar group', area: 'area', thread: 'thread', doc: 'file', plot: 'plot' };
    const counts = {};
    for (const k of memberKeys) { const t = k.split(':')[0]; counts[t] = (counts[t] || 0) + 1; }
    const parts = order.filter((t) => counts[t]).map((t) => `${counts[t]} ${noun[t]}${counts[t] === 1 ? '' : 's'}`);
    const nC = compiledShas.length;
    return `${parts.join(', ') || 'empty'} · spanning ${nC} commit${nC === 1 ? '' : 's'}`;
  }, [memberKeys, compiledShas]);

  return (
    <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1100 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ width: 14, height: 14, background: group.color || WF.ink2, border: inkBorder() }} />
          <Chip bg={group.color || WF.ink2} color={WF.onAccent}>user group</Chip>
          <L mono size={11} color={WF.ink3}>{memberKeys.length} item{memberKeys.length === 1 ? '' : 's'}</L>
          <div style={{ flex: 1 }} />
          {armed ? (
            <>
              <Chip onClick={() => { deleteUserGroup(group.id); }} style={{ cursor: 'pointer', background: WF.heat4, color: WF.onAccent, borderColor: WF.heat4 }} title="permanently delete this group and untag every item">confirm delete</Chip>
              <Chip onClick={() => setArmed(false)} style={{ cursor: 'pointer' }}>cancel</Chip>
            </>
          ) : (
            <Chip onClick={() => setArmed(true)} style={{ cursor: 'pointer', background: WF.paperAlt, color: WF.ink2 }} title="delete this group (its members are untagged, not deleted)">✕ delete group</Chip>
          )}
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          aria-label="group name"
          style={{
            marginTop: 10, width: '100%', boxSizing: 'border-box',
            fontFamily: WF.bodyFont, fontSize: 18, fontWeight: 700,
            padding: '6px 8px', border: inkBorder(1.2), background: WF.paper, color: WF.ink,
          }}
        />
        <CopyBlock
          size={10.5}
          italic
          style={{ marginTop: 8 }}
          text={`${UI_HANDOFF_PREFIX}${traceLocation(currentTrace)}Investigate my audit tag group "${(name || '').trim() || group.name}" — ${groupScope}. Resolve it via the schema in the UI's AGENTS.md.`}
        />
      </div>

      <section>
        <SectionHead title="members" count={memberKeys.length} hint="click to open, × to remove" accent={group.color || WF.ink2} />
        {memberKeys.length === 0 && (
          <L mono size={11} color={WF.ink3} style={{ display: 'block', paddingLeft: 2 }}>
            nothing tagged yet — flag a commit / area / thread / group / document and add it to “{group.name}”.
          </L>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {memberKeys.map((key) => (
            <UserGroupMemberRow
              key={key}
              memberKey={key}
              groupId={group.id}
              describe={describe}
              src={src}
              onUntag={untagTarget}
              onOpenCommit={openCommit}
            />
          ))}
        </div>
      </section>

      {/* Documents & plots, collapsed by default — the final-report docs /
          pngs tagged into the group, ahead of the commit diff timeline. */}
      <GroupDocsPlots docPlotKeys={docPlotKeys} describe={describe} selectedInput={selectedInput} />

      {/* The compiled commit diff timeline: every commit the members cover,
          rendered whole and in order, the same shape the threads page uses. */}
      {compiledShas.length > 0 && (
        <ThreadProgression
          shas={compiledShas}
          accent={group.color || WF.heat3}
          onOpenCommit={openCommit}
          title="commit diff timeline"
          hint={`full diff for each of the ${compiledShas.length} commit${compiledShas.length === 1 ? '' : 's'} above · in order`}
        />
      )}

      <section>
        <SectionHead title="auditor comments" count={auditorComments.length} hint="your notes on this group and everything tagged into it" accent={WF.ink} />
        {auditorComments.length === 0 ? (
          <L mono size={11} color={WF.ink3} style={{ display: 'block', paddingLeft: 2 }}>
            no auditor comments yet — add one on this group (right panel) or note any tagged item.
          </L>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {auditorComments.map((c, i) => (
              <Box key={c.key + ':' + c.note.id + ':' + i} style={{ padding: 10, borderLeft: `4px solid ${WF.ink}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  <Chip>{c.kind}</Chip>
                  <L
                    size={11}
                    color={WF.ink2}
                    onClick={c.open || undefined}
                    style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(c.open ? { cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 2 } : {}) }}
                    title={c.open ? 'open this item' : undefined}
                  >{anon(c.label)}</L>
                </div>
                <L size={13} style={{ display: 'block', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{c.note.text}</L>
              </Box>
            ))}
          </div>
        )}
      </section>

      <AgentCommentsDropdown annotation={agentComments.annotation} thread={agentComments.thread} onOpenCommit={openCommit} />
    </div>
  );
}

// Collapsed-by-default disclosure of the document / plot members of a group: the
// tagged final-report docs and result pngs, shown ahead of the commit diff
// timeline. A plot renders its figure inline; a doc links into the results
// screen. Folded by default so the diff timeline stays the focus.
function GroupDocsPlots({ docPlotKeys, describe, selectedInput }) {
  const anon = useAnonymize();
  const [open, setOpen] = React.useState(false);
  if (!docPlotKeys || docPlotKeys.length === 0) return null;
  return (
    <section>
      <div
        onClick={() => setOpen((v) => !v)}
        title={open ? 'hide documents & plots' : 'show documents & plots'}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
          background: WF.paperAlt, border: inkBorder(), cursor: 'pointer', userSelect: 'none',
        }}
      >
        <L mono size={12} color={WF.ink2} style={{ width: 12, textAlign: 'center' }}>{open ? '▾' : '▸'}</L>
        <L size={14} weight={700}>documents &amp; plots</L>
        <Chip>{docPlotKeys.length}</Chip>
        <L mono size={10} color={WF.ink3}>final-report docs &amp; figures · collapsed by default</L>
      </div>
      {open && (
        <div style={{ border: inkBorder(), borderTop: 'none', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {docPlotKeys.map((key) => {
            const d = describe(key);
            const isPlot = key.startsWith('plot:');
            const file = isPlot ? key.slice('plot:'.length) : null;
            const url = isPlot && selectedInput ? `/data/${selectedInput}/main_results/${file}` : null;
            return (
              <Box key={key} style={{ padding: 10 }}>
                <div
                  onClick={d?.open || undefined}
                  title={d?.open ? 'open on the results screen' : undefined}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: isPlot ? 8 : 0, cursor: d?.open ? 'pointer' : 'default', flexWrap: 'wrap' }}
                >
                  <L mono size={12} color={WF.ink3} style={{ width: 14, textAlign: 'center' }}>{d?.icon || '▤'}</L>
                  <Chip>{d?.kind || (isPlot ? 'plot' : 'doc')}</Chip>
                  <L size={13} weight={600} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{anon(d?.label || key)}</L>
                  {isPlot && <L mono size={10} color={WF.ink3}>{anon(file)}</L>}
                  {d?.open && <L mono size={11} color={WF.ink3}>open →</L>}
                </div>
                {isPlot && url && (
                  <a href={url} target="_blank" rel="noreferrer" title="open full size">
                    <img src={url} alt={anon(d?.label || file)} style={{ display: 'block', width: '100%', height: 'auto', border: inkBorder(1.2), background: WF.paper }} />
                  </a>
                )}
              </Box>
            );
          })}
        </div>
      )}
    </section>
  );
}

// Collapsed-by-default disclosure of the agent-generated commentary across a
// group's members: the annotation agent's "what is being done" notes and the
// thread agent's beat / direction / reasoning notes. Folded away by default so
// the auditor's own comments lead; one click expands the model's commentary.
function AgentCommentsDropdown({ annotation, thread, onOpenCommit }) {
  const [open, setOpen] = React.useState(false);
  const total = annotation.length + thread.length;
  return (
    <section>
      <div
        onClick={() => setOpen((v) => !v)}
        title={open ? 'hide agent-generated comments' : 'show agent-generated comments'}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
          background: WF.paperAlt, border: inkBorder(), cursor: 'pointer', userSelect: 'none',
        }}
      >
        <L mono size={12} color={WF.ink2} style={{ width: 12, textAlign: 'center' }}>{open ? '▾' : '▸'}</L>
        <L size={14} weight={700}>agent-generated comments</L>
        <Chip>{total}</Chip>
        <L mono size={10} color={WF.ink3}>annotation + thread agents · collapsed by default</L>
      </div>
      {open && (
        <div style={{ border: inkBorder(), borderTop: 'none', padding: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {total === 0 && (
            <L mono size={11} color={WF.ink3}>no agent comments on this group’s members.</L>
          )}
          {annotation.length > 0 && (
            <div>
              <L size={11} weight={700} color={WF.ink3} style={{ display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>annotation agent · {annotation.length}</L>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {annotation.map((c, i) => <AgentCommentCard key={'a' + i} c={c} accent={WF.panel} onOpenCommit={onOpenCommit} />)}
              </div>
            </div>
          )}
          {thread.length > 0 && (
            <div>
              <L size={11} weight={700} color={WF.ink3} style={{ display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>🧵 thread agent · {thread.length}</L>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {thread.map((c, i) => <AgentCommentCard key={'t' + i} c={c} accent={WF.catBlue} onOpenCommit={onOpenCommit} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// One agent comment: a source line (the commit it's on, or a group / thread
// scope) above the model's text. Clicking the source opens that commit in the
// dossier when the comment is commit-scoped.
function AgentCommentCard({ c, accent = WF.ink2, onOpenCommit }) {
  const anon = useAnonymize();
  const clickable = c.scope === 'commit' && c.id && onOpenCommit;
  return (
    <Box style={{ padding: 10, borderLeft: `4px solid ${accent}` }}>
      <div
        onClick={clickable ? () => onOpenCommit(c.id) : undefined}
        title={clickable ? 'open this commit in the dossier' : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap', cursor: clickable ? 'pointer' : 'default' }}
      >
        {c.scope === 'commit' && <Sha sha={c.sha} size={11} weight={700} />}
        {c.scope === 'group' && <Chip>group</Chip>}
        {c.scope === 'thread' && <Chip bg={WF.catBlue} color={WF.onAccent}>🧵 thread</Chip>}
        {c.file && <L mono size={11} color={WF.ink2}>{anon(c.file)}</L>}
        {(c.title || c.label) && <L size={12} color={WF.ink2} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{anon(c.title || c.label)}</L>}
        {clickable && <L mono size={11} color={WF.ink3}>open →</L>}
      </div>
      <L size={13} color={WF.ink2} style={{ display: 'block', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{renderInline(anon(c.text))}</L>
    </Box>
  );
}

function TextBlock({ label, text, accent = WF.ink }) {
  const anon = useAnonymize();
  if (!text) return null;
  // `label` is the static section name (chrome); only `text` is trace-derived.
  return (
    <Box style={{ padding: 12, borderLeft: `5px solid ${accent}` }}>
      <L size={11} weight={700} color={WF.ink3}>{label}</L>
      <L size={13} style={{ display: 'block', marginTop: 4, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{renderInline(anon(text))}</L>
    </Box>
  );
}

// The chronological commits in an area or thread. Each resolves (by inner SHA)
// back to a dossier chunk so clicking jumps into the inbox at that commit. When
// `beats` is supplied (threads), each commit's beat note is shown beneath it.
function CommitStrip({ shas, onOpenCommit, beats, title = 'commits in this area' }) {
  const { data } = useData();
  const anon = useAnonymize();
  const { bySha = {}, byId = {} } = data;
  return (
    <section>
      <SectionHead title={title} count={shas.length} hint="chronological · may be non-adjacent in history" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {shas.map((sha, i) => {
          const stub = bySha[sha];
          const chunk = stub ? (byId[stub.id] || stub) : null;
          const note = beats ? beats[sha] : '';
          return (
            <Box
              key={sha}
              onClick={chunk ? () => onOpenCommit(chunk.id) : undefined}
              style={{ padding: '8px 10px', cursor: chunk ? 'pointer' : 'default' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <L mono size={10} color={WF.ink3} style={{ width: 18 }}>{stateLabel(i)}</L>
                <Chip>{chunk ? chunk.kind : '?'}</Chip>
                <Sha sha={sha} size={11} weight={700} />
                {chunk?.file && <L mono size={11} color={WF.ink2}>{anon(chunk.file)}</L>}
                <L size={12} color={WF.ink2} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {chunk ? anon(chunk.title) : '(commit not in this trace’s event map)'}
                </L>
                {chunk && <Check on={chunk.visited} />}
                {chunk && <L mono size={11} color={WF.ink3}>→</L>}
              </div>
              {note && (
                <L size={12} color={WF.ink2} style={{ display: 'block', marginTop: 4, paddingLeft: 28, lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
                  {renderInline(anon(note))}
                </L>
              )}
            </Box>
          );
        })}
      </div>
    </section>
  );
}

function SectionHead({ title, count, hint, accent = WF.ink }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
      <div style={{ width: 12, height: 12, background: accent, border: inkBorder() }} />
      <L size={15} weight={700}>{title}</L>
      {count != null && <Chip>{count}</Chip>}
      {hint && <L mono size={10} color={WF.ink3}>· {hint}</L>}
    </div>
  );
}

// Fetch each area commit's `git show`, parse it, and pivot the patches by file
// path so each file's states line up in chronological order — the A→B→C
// progression. Returns { status, byPath: [{ path, isLog, states:[{sha,file}] }] }.
function useAreaProgression(shas) {
  const { selectedInput } = useData();
  const [state, setState] = React.useState({ status: 'idle', byPath: [], logsByCommit: [], error: null });

  React.useEffect(() => {
    if (!shas || shas.length === 0) { setState({ status: 'empty', byPath: [], logsByCommit: [], error: null }); return undefined; }
    let cancelled = false;
    setState({ status: 'loading', byPath: [], logsByCommit: [], error: null });

    Promise.all(shas.map(async (sha) => {
      const r = await fetch(`/api/diff?sha=${encodeURIComponent(sha)}${nameParam(selectedInput)}`);
      const text = await r.text();
      if (!r.ok) throw new Error(text || `HTTP ${r.status}`);
      return { sha, parsed: parseDiff(text) };
    }))
      .then((commits) => {
        if (cancelled) return;
        // path → ordered states. `shas` is already chronological, so iterating
        // commits in order yields each file's states oldest-first.
        const map = new Map();
        for (const { sha, parsed } of commits) {
          // Logs are pivoted by commit (below), not by file, so only source
          // files feed the per-file progression map.
          for (const file of parsed.other) {
            if (!map.has(file.path)) map.set(file.path, { path: file.path, isLog: false, states: [] });
            map.get(file.path).states.push({ sha, file });
          }
        }
        // Most-changed (most states) first.
        const byPath = [...map.values()].sort((a, b) => (b.states.length - a.states.length) || a.path.localeCompare(b.path));
        // Logs grouped by commit instead of by file: one table per commit whose
        // rows are the log files it touched. `areaIndex` is the commit's
        // chronological position in the area, so the state label (A/B/C…) lines
        // up with the code progression.
        const logsByCommit = commits
          .map(({ sha, parsed }, areaIndex) => ({ sha, areaIndex, logs: parsed.logs }))
          .filter((c) => c.logs.length > 0);
        setState({ status: 'ready', byPath, logsByCommit, error: null });
      })
      .catch((err) => { if (!cancelled) setState({ status: 'error', byPath: [], logsByCommit: [], error: err.message }); });

    return () => { cancelled = true; };
  }, [shas, selectedInput]);

  return state;
}

function AreaProgression({ shas }) {
  const { status, byPath, logsByCommit, error } = useAreaProgression(shas);
  const codeFiles = byPath; // hook now keeps only source files in byPath
  const hasAnything = codeFiles.length > 0 || logsByCommit.length > 0;

  return (
    <section>
      <SectionHead
        title="code progression"
        count={status === 'ready' ? codeFiles.length : null}
        hint="per file, each state across the area’s commits"
        accent={WF.heat3}
      />
      {status === 'loading' && <LoadingBox label={`loading ${shas.length} commit diff${shas.length === 1 ? '' : 's'}`} height={64} style={{ marginTop: 8 }} />}
      {status === 'error' && <L mono size={11} color={WF.heat4}>error: {error}</L>}
      {status === 'ready' && !hasAnything && (
        <L mono size={11} color={WF.ink3}>no file changes across these commits (metadata-only commits)</L>
      )}
      {status === 'ready' && codeFiles.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {codeFiles.map((fp) => <FileProgression key={fp.path} fp={fp} />)}
        </div>
      )}
      {status === 'ready' && codeFiles.length === 0 && logsByCommit.length > 0 && (
        <L mono size={11} color={WF.ink3}>no source-file changes — log artifacts only</L>
      )}

      {/* Logs live in their own walled-off area: append-heavy trace artifacts,
          not auditable source, so they sit below a divider with a distinct
          (ink, not heat) accent to keep them from reading as code diffs.
          Unlike code (pivoted by file), logs are grouped by commit — one table
          per commit whose rows are the log files that commit touched. */}
      {status === 'ready' && logsByCommit.length > 0 && (
        <div style={{ marginTop: 28, borderTop: `2px solid ${WF.ink2}`, paddingTop: 18 }}>
          <SectionHead
            title="log artifacts"
            count={logsByCommit.length}
            hint="trace output — grouped by commit, changed lines only"
            accent={WF.ink2}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {logsByCommit.map((c) => (
              <LogCommitGroup key={c.sha} sha={c.sha} index={c.areaIndex} total={shas.length} logs={c.logs} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function FileProgression({ fp }) {
  // Resolve each state's sha to its chunk id so the strip can deep-link into the
  // dossier inbox; commits in an area always come from the loaded trace, but a
  // missing entry just renders unclickable rather than failing.
  const { data, openCommit } = useData();
  const anon = useAnonymize();
  const bySha = data?.bySha || {};
  const idForSha = (sha) => bySha[sha]?.id || null;
  const headerId = idForSha(fp.states[0]?.sha);
  return (
    <Box style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: WF.paperAlt, borderBottom: inkBorder() }}>
        <span
          onClick={headerId ? () => openCommit(headerId) : undefined}
          title={headerId ? 'open the first commit in this file’s chain in the dossier inbox' : undefined}
          style={headerId ? { cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 2 } : undefined}
        >
          <L mono size={13} weight={700}>{anon(fp.path)}</L>
        </span>
        {fp.isLog && <Chip>log file</Chip>}
        <div style={{ flex: 1 }} />
        <L mono size={10} color={WF.ink3}>{fp.states.length} state{fp.states.length === 1 ? '' : 's'}</L>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {fp.states.map((st, i) => {
          const id = idForSha(st.sha);
          return (
            <div key={st.sha + ':' + i} style={{ borderTop: i === 0 ? 'none' : `1px dashed ${WF.rule2}` }}>
              <div
                onClick={id ? () => openCommit(id) : undefined}
                title={id ? 'open this commit in the dossier inbox' : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  cursor: id ? 'pointer' : undefined,
                }}
              >
                <Chip bg={WF.ink} color={WF.paper}>{stateLabel(i)}</Chip>
                <Sha sha={st.sha} size={11} weight={700} />
                <L mono size={10} color={WF.ink3}>state {i + 1} of {fp.states.length}</L>
              </div>
              <div style={{ padding: '0 12px 12px' }}>
                <FileDiff file={st.file} sha={st.sha} />
              </div>
            </div>
          );
        })}
      </div>
    </Box>
  );
}

// The per-commit suspicion justifications for the area/thread's members, lifted
// to a single section above the commit listing. Each member commit carries its
// own suspicion entries (independent of the area's own anchoring suspicion) —
// both the anchor's and any flags an evidence commit picked up on its own. A
// commit can appear several times across the file/log progression (once per
// file it touched), so surfacing the suspicions per-state below the diff would
// repeat the same wording; instead, list them once here, grouped by commit, and
// reuse the dossier's SuspicionDetail so the wording matches the inbox.
function MemberSuspicionsSummary({ shas }) {
  const { data, openCommit } = useData();
  const anon = useAnonymize();
  const { bySha = {}, byId = {} } = data;
  const groups = [];
  for (let i = 0; i < (shas || []).length; i += 1) {
    const sha = shas[i];
    const stub = bySha[sha];
    const chunk = stub ? (byId[stub.id] || stub) : null;
    const suspicions = chunk?.suspicions || [];
    if (suspicions.length === 0) continue;
    groups.push({ sha, chunk, suspicions, index: i });
  }
  if (groups.length === 0) return null;
  const total = groups.reduce((n, g) => n + g.suspicions.length, 0);
  return (
    <section>
      <SectionHead
        title="member-commit suspicions"
        count={total}
        hint={`flag notes attached to ${groups.length} of ${shas.length} commit${shas.length === 1 ? '' : 's'} — not repeated below`}
        accent={WF.heat4}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {groups.map(({ sha, chunk, suspicions, index }) => (
          <Box key={sha} style={{ padding: 10 }}>
            <div
              onClick={chunk ? () => openCommit(chunk.id) : undefined}
              style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: chunk ? 'pointer' : 'default', marginBottom: 8 }}
              title={chunk ? 'open this commit in the dossier inbox' : undefined}
            >
              <L mono size={10} color={WF.ink3} style={{ width: 18 }}>{stateLabel(index)}</L>
              <Sha sha={sha} size={11} weight={700} />
              {chunk?.file && <L mono size={11} color={WF.ink2}>{anon(chunk.file)}</L>}
              <L size={12} color={WF.ink2} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {chunk ? anon(chunk.title) : '(commit not in this trace’s event map)'}
              </L>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {suspicions.map((s, i) => (
                <SuspicionDetail key={s.suspicion_id || i} s={s} byId={byId} onNavigate={openCommit} />
              ))}
            </div>
          </Box>
        ))}
      </div>
    </section>
  );
}

// Log-artifact group for one commit: a single box whose rows are the log files
// that commit touched. Logs are append-heavy trace artifacts, so each row drops
// the hunk headers and context and shows only the changed (+/−) lines. Mirrors
// the dossier inbox's LogDiffTable (one row per file), but here scoped to a
// single area commit and headed with that commit's chronological state label.
function LogCommitGroup({ sha, index, total, logs }) {
  const border = `1px solid ${WF.rule}`;
  return (
    <Box style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: WF.paperAlt, borderBottom: inkBorder() }}>
        <Chip bg={WF.ink} color={WF.paper}>{stateLabel(index)}</Chip>
        <Sha sha={sha} size={13} weight={700} />
        <L mono size={10} color={WF.ink3}>commit {index + 1} of {total}</L>
        <div style={{ flex: 1 }} />
        <L mono size={10} color={WF.ink3}>{logs.length} log file{logs.length === 1 ? '' : 's'}</L>
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: '32%' }} />
          <col style={{ width: '68%' }} />
        </colgroup>
        <tbody>
          {logs.map((file, i) => (
            <LogFileRow key={file.path + ':' + i} file={file} first={i === 0} border={border} />
          ))}
        </tbody>
      </table>
    </Box>
  );
}

// Visible-row cap for a log file's diff body. ColoredDiffBody renders at
// fontSize 11 / lineHeight 1.45 (≈16px/line) plus 8px top+bottom padding, so a
// 12-row cap is ≈ 12*16 + 16. Past that the body scrolls inside the row,
// keeping the log table compact no matter how big any one file's append is.
const LOG_ROW_MAX_ROWS = 12;
const LOG_ROW_MAX_HEIGHT = Math.round(LOG_ROW_MAX_ROWS * 11 * 1.45) + 16;

function LogFileRow({ file, first, border }) {
  const anon = useAnonymize();
  const [full, setFull] = React.useState(false);
  const adds = file.body.filter((l) => /^\+[^+]/.test(l)).length;
  const dels = file.body.filter((l) => /^-[^-]/.test(l)).length;
  const isNew = file.meta.some((l) => /^new file mode/.test(l));
  const isDeleted = file.meta.some((l) => /^deleted file mode/.test(l));
  // Only the changed lines — additions and deletions. Hunk headers (@@) and
  // unchanged context lines are dropped, same as the dossier's log table.
  const changed = file.body.filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  const bigLog = changed.length > BIG_FILE_LINES;
  const shown = bigLog && !full ? changed.slice(0, PREVIEW_LINES) : changed;
  const cell = { borderTop: first ? 'none' : border, verticalAlign: 'top' };
  return (
    <tr>
      <td style={{ ...cell, borderRight: border, background: WF.paper, padding: '8px 10px' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <L mono size={11} weight={700} style={{ wordBreak: 'break-all' }}>{anon(file.path)}</L>
          {adds > 0 && <L mono size={11} color={WF.add}>+{adds}</L>}
          {dels > 0 && <L mono size={11} color={WF.heat4}>−{dels}</L>}
          {file.isBinary && <Chip>binary</Chip>}
          {isNew && <Chip>new file</Chip>}
          {isDeleted && <Chip>deleted</Chip>}
        </div>
      </td>
      <td style={{ ...cell, padding: 0 }}>
        {file.isBinary ? (
          <L mono size={11} color={WF.ink3} style={{ display: 'block', padding: '8px 10px' }}>binary file — no line diff</L>
        ) : changed.length > 0 ? (
          <>
            <ColoredDiffBody lines={shown} maxHeight={LOG_ROW_MAX_HEIGHT} />
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
