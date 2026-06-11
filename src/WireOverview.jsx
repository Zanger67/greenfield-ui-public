// Overview — the auditor's consolidated output view. Surfaces the chunks
// the auditor flagged with the [ ] flag, alongside the suspicion pass and
// every user-authored note. This is what will eventually get serialised
// into the auditor's output JSON artifact at the end of a session.
import React from 'react';
import {
  WF,
  inkBorder,
  L,
  Box,
  Chip,
  Check,
  AppFrame,
} from './primitives.jsx';
import { useData } from './dataStore.jsx';
import { ScreenTabs } from './App.jsx';
import { TopBarControls, Sha, useAnonymize } from './settings.jsx';
import { usergroupKey, reverseTagIndex, useDescribeTarget, GroupTagChips } from './Tagging.jsx';
import { collectGroupMarkups, collectSemanticMarkups, collectDocMarkups, collectPlotMarkups } from './auditExport.js';

// The overlay target key a flagged descriptor was stored under — so its group
// tags (keyed by that same key) can be read back onto the overview row. Groups /
// semantic areas / docs / plots carry their namespaced key; a bare commit uses
// its id.
const rowTargetKey = (c) => c._groupKey || c._semKey || c._docKey || c._plotKey || c.id;

export function WireOverview() {
  const { data, rawData, showAiSuspicion, openCommit, openArea, openThread, openGroup, openDoc, openUserGroup, toggleDismiss, flaggedOverlay = {}, userNotesOverlay = {}, userGroupsOverlay = {}, groupTagsOverlay = {} } = useData();
  const { chunks, coverage, meta, semanticAreas = [], threads = [] } = data;
  const describe = useDescribeTarget();

  // The auditor's user groups, each with its resolved member list + annotations,
  // so the consolidated output shows what was grouped and any group-level notes.
  const memberIndex = React.useMemo(() => reverseTagIndex(groupTagsOverlay), [groupTagsOverlay]);
  const userGroups = React.useMemo(
    () => Object.values(userGroupsOverlay).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)),
    [userGroupsOverlay],
  );

  // Group-level auditor markups: a group can be flagged / annotated as a whole
  // alongside its members, persisted under `group:<id>` overlay keys. Reconstruct
  // group descriptors from chunks sharing a groupId so those markups surface here
  // beside the commit-level ones.
  const groupMarkups = React.useMemo(
    () => collectGroupMarkups(chunks, flaggedOverlay, userNotesOverlay),
    [chunks, flaggedOverlay, userNotesOverlay],
  );
  // Semantic-area / thread markups: flag + validator notes the auditor attached
  // to a flagged area or a thread (AuditorPanel on the areas screen, persisted
  // under `area:<id>` / `thread:<id>`). Same chunk-shaped descriptor so they
  // flow through OverviewSection / OverviewRow — clicking routes to the areas
  // screen with the right item focused, instead of the dossier.
  const semanticMarkups = React.useMemo(
    () => collectSemanticMarkups(semanticAreas, threads, flaggedOverlay, userNotesOverlay),
    [semanticAreas, threads, flaggedOverlay, userNotesOverlay],
  );
  // Result-document markups: flag + validator notes the auditor attached to a
  // doc on the final-results screen, persisted under `doc:<id>` overlay keys.
  // Purely overlay-derived (docs aren't commits), so they don't depend on the
  // chunk data; clicking routes back to that doc on the results screen.
  const docMarkups = React.useMemo(
    () => collectDocMarkups(flaggedOverlay, userNotesOverlay),
    [flaggedOverlay, userNotesOverlay],
  );
  // Per-plot markups (final-results plots gallery), keyed `plot:<file>` — each
  // figure flagged / noted individually, surfaced here like the doc markups.
  const plotMarkups = React.useMemo(
    () => collectPlotMarkups(flaggedOverlay, userNotesOverlay),
    [flaggedOverlay, userNotesOverlay],
  );

  const flaggedCommits = chunks.filter((c) => c.userFlagged);
  const flagged = [
    ...flaggedCommits,
    ...groupMarkups.filter((g) => g.userFlagged),
    ...semanticMarkups.filter((m) => m.userFlagged),
    ...docMarkups.filter((m) => m.userFlagged),
    ...plotMarkups.filter((m) => m.userFlagged),
  ];
  const commitsWithUserNotes = chunks.filter((c) => (c.userNotes || []).length > 0);
  const chunksWithUserNotes = [
    ...commitsWithUserNotes,
    ...groupMarkups.filter((g) => (g.userNotes || []).length > 0),
    ...semanticMarkups.filter((m) => (m.userNotes || []).length > 0),
    ...docMarkups.filter((m) => (m.userNotes || []).length > 0),
    ...plotMarkups.filter((m) => (m.userNotes || []).length > 0),
  ];
  // Notes on items the auditor also flagged now render inline under that item in
  // the Flagged section, so the dedicated notes section carries only the *other*
  // notes — those on items that weren't flagged — to avoid showing the same note
  // in two places.
  const otherNotes = chunksWithUserNotes.filter((c) => !c.userFlagged);
  // Agent-surfaced suspicions, ranked high→low. Dismissed ones split off into
  // their own demoted section so the auditor's live queue isn't cluttered by
  // commits they've already looked at and cleared.
  const rankedSuspicion = chunks
    .filter((c) => c.flagLevel)
    .sort((a, b) => suspicionRank(b.flagLevel) - suspicionRank(a.flagLevel));
  const suspicionCommits = rankedSuspicion.filter((c) => !c.suspicionDismissed);
  const dismissedSuspicion = rankedSuspicion.filter((c) => c.suspicionDismissed);

  // Dispatch open by descriptor kind: semantic-area / thread descriptors deep-
  // link onto the areas screen with that item focused; everything else (commits
  // and groups, both routed via the commit's chunk id) opens in the dossier.
  const openChunk = (c) => {
    if (c?._isArea) openArea(c._areaId);
    else if (c?._isThread) openThread(c._threadId);
    else if (c?._isDoc) openDoc(c._docId);
    else if (c?._isPlot) openDoc('plots');
    else if (c?._isGroup) openGroup(c._groupId, c.id);
    else openCommit(c?.id);
  };

  const exportBlob = () => {
    // The export is the auditor's deliverable, so it carries ONLY user-authored
    // items — the auditor's own flags and notes. This download keeps its own
    // camelCase shape for a human; the canonical on-disk store the local agent
    // reads is built by buildAuditModel + serializeAuditFiles in auditExport.js.
    // The AI suspicion layer (narrator
    // flag levels, deterministic pre-flags, suspicion coverage) is deliberately
    // left out, whatever the AI-flags view toggle is set to. Read from the ungated
    // data so user markups on suspicion-derived areas still export when the toggle
    // is off (the gate drops those areas from `data`); collectGroup/SemanticMarkups
    // already keep only user-flagged / user-noted entries.
    const exData = rawData || data;
    const exGroups = collectGroupMarkups(exData.chunks, flaggedOverlay, userNotesOverlay);
    const exSemantic = collectSemanticMarkups(exData.semanticAreas, exData.threads, flaggedOverlay, userNotesOverlay);
    // Doc + per-plot markups are overlay-only, so the same collectors serve the export.
    const exDocs = collectDocMarkups(flaggedOverlay, userNotesOverlay);
    const exPlots = collectPlotMarkups(flaggedOverlay, userNotesOverlay);
    // The user-group names a given target was tagged into — folded onto every
    // exported item so the grouping is legible without cross-referencing ids.
    const groupNamesFor = (key) =>
      (groupTagsOverlay[key] || []).map((id) => userGroupsOverlay[id]?.name).filter(Boolean);
    // Headline count is the auditor's own flags, not the AI flag tally.
    const userFlagCount =
      exData.chunks.filter((c) => c.userFlagged).length +
      exGroups.filter((g) => g.userFlagged).length +
      exSemantic.filter((m) => m.userFlagged).length +
      exDocs.filter((m) => m.userFlagged).length +
      exPlots.filter((m) => m.userFlagged).length;
    const out = {
      exportedAt: new Date().toISOString(),
      session: {
        experiment: meta?.experiment,
        tStart: meta?.tStart,
        tEnd: meta?.tEnd,
        commitCount: meta?.eventCount,
        flagCount: userFlagCount,
      },
      // User progress + trace size only — the AI suspicion-seen/total weights stay out.
      coverage: { visited: exData.coverage?.visited, total: exData.coverage?.total },
      commits: exData.chunks
        .filter((c) => c.userFlagged || (c.userNotes || []).length > 0)
        .map((c) => ({
          id: c.id,
          sha: c.sha,
          kind: c.kind,
          file: c.file,
          t: c.t,
          userFlagged: !!c.userFlagged,
          groups: groupNamesFor(c.id),
          userNotes: (c.userNotes || []).map((n) => ({
            id: n.id, text: n.text, createdAt: n.createdAt, editedAt: n.editedAt,
          })),
        })),
      groups: exGroups.map((g) => ({
        groupId: g._groupId,
        kind: g.kind,
        root: g.file,
        firstSha: g.sha,
        lastSha: g._lastSha,
        userFlagged: !!g.userFlagged,
        groups: groupNamesFor(g._groupKey),
        userNotes: (g.userNotes || []).map((n) => ({
          id: n.id, text: n.text, createdAt: n.createdAt, editedAt: n.editedAt,
        })),
      })),
      semantic: exSemantic.map((m) => ({
        kind: m._isArea ? 'area' : 'thread',
        id: m._areaId || m._threadId,
        title: m.title,
        category: m._category || null,
        theme: m._theme || null,
        commitCount: m._commitCount || 0,
        userFlagged: !!m.userFlagged,
        groups: groupNamesFor(m._semKey),
        userNotes: (m.userNotes || []).map((n) => ({
          id: n.id, text: n.text, createdAt: n.createdAt, editedAt: n.editedAt,
        })),
      })),
      documents: exDocs.map((m) => ({
        id: m._docId,
        title: m.title,
        path: m.file || null,
        userFlagged: !!m.userFlagged,
        groups: groupNamesFor(m._docKey),
        userNotes: (m.userNotes || []).map((n) => ({
          id: n.id, text: n.text, createdAt: n.createdAt, editedAt: n.editedAt,
        })),
      })),
      plots: exPlots.map((m) => ({
        file: m._plotFile,
        title: m.title,
        path: m.file || null,
        userFlagged: !!m.userFlagged,
        groups: groupNamesFor(m._plotKey),
        userNotes: (m.userNotes || []).map((n) => ({
          id: n.id, text: n.text, createdAt: n.createdAt, editedAt: n.editedAt,
        })),
      })),
      // The auditor's own user groups: each with its annotations and the list of
      // items tagged into it (resolved to a label + kind). The whole registry is
      // exported, even an empty group, since the grouping itself is intent.
      userGroups: userGroups.map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color || null,
        createdAt: g.createdAt,
        userFlagged: !!flaggedOverlay[usergroupKey(g.id)],
        annotations: (userNotesOverlay[usergroupKey(g.id)] || []).map((n) => ({
          id: n.id, text: n.text, createdAt: n.createdAt, editedAt: n.editedAt,
        })),
        members: (memberIndex[g.id] || []).map((key) => {
          const d = describe(key);
          return { targetKey: key, kind: d?.kind || null, label: d?.label || null };
        }),
      })),
    };
    const json = JSON.stringify(out, null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `redlogs_audit_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppFrame
      topBar={<ScreenTabs />}
      subtitle="auditor output"
      coverageProps={{ ...coverage, showSuspicion: showAiSuspicion }}
      rightSlot={<TopBarControls />}
    >
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1100, margin: '0 auto' }}>
          <SummaryBar
            flagged={flagged.length}
            notes={chunksWithUserNotes.reduce((n, c) => n + (c.userNotes || []).length, 0)}
            groups={userGroups.length}
            total={chunks.length}
            onExport={exportBlob}
          />

          <OverviewSection
            title="Flagged"
            accent={WF.heat4}
            empty="No chunks flagged yet. Use the [ ] flag on a chunk to mark it."
            chunks={flagged}
            showNotes
            onOpen={openChunk}
          />
          <OverviewSection
            title="Your other notes"
            accent={WF.ink2}
            empty="No notes on un-flagged items. Notes on flagged items show under Flagged above."
            chunks={otherNotes}
            showNotes
            onOpen={openChunk}
          />

          <UserGroupsSection
            groups={userGroups}
            memberIndex={memberIndex}
            describe={describe}
            flaggedOverlay={flaggedOverlay}
            userNotesOverlay={userNotesOverlay}
            onOpenGroup={openUserGroup}
          />

          {/* The AI suspicion sections are gated behind the top-bar AI-flags
              pill (default off, anti-anchoring). When off the data store has
              already neutralized these chunks; hiding the sections too keeps
              their headers/empty-state from advertising a layer the auditor
              chose to silence. */}
          {showAiSuspicion && (
            <OverviewSection
              title="Suspicion (pre-flagged by AI analysis)"
              accent={WF.heat4}
              empty="No commits surfaced by the suspicion pass."
              chunks={suspicionCommits}
              showSuspicions
              collapsible
              defaultOpen={false}
              onOpen={openChunk}
              onDismiss={toggleDismiss}
            />
          )}
          {showAiSuspicion && dismissedSuspicion.length > 0 && (
            <OverviewSection
              title="Suspicion flagged by agent — user dismissed"
              accent={WF.heat2}
              empty="Nothing dismissed."
              chunks={dismissedSuspicion}
              showSuspicions
              dimmed
              collapsible
              defaultOpen={false}
              onOpen={openChunk}
              onDismiss={toggleDismiss}
            />
          )}
        </div>
      </div>
    </AppFrame>
  );
}

function suspicionRank(level) {
  return { high: 3, medium: 2, low: 1, mild: 1 }[level] || 0;
}

// The auditor's user groups, consolidated: one card per group with its member
// list (each item routes to its home screen) and any group-level annotations.
// This is the overview's mirror of the semantic-areas "user groups" category —
// the grouping the auditor built propagates here as part of the output view.
function UserGroupsSection({ groups, memberIndex, describe, flaggedOverlay, userNotesOverlay, onOpenGroup }) {
  const anon = useAnonymize();
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ width: 14, height: 14, background: WF.ink2, border: inkBorder() }} />
        <L size={16} weight={700}>User groups</L>
        <Chip>{groups.length}</Chip>
      </div>
      {groups.length === 0 && (
        <L size={12} color={WF.ink3} style={{ display: 'block', paddingLeft: 24, fontStyle: 'italic' }}>
          No user groups yet. Flag an item and tag it into a group from the dossier or the auditor panel.
        </L>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {groups.map((g) => {
          const members = memberIndex[g.id] || [];
          const notes = userNotesOverlay[usergroupKey(g.id)] || [];
          const flagged = !!flaggedOverlay[usergroupKey(g.id)];
          return (
            <Box
              key={g.id}
              onClick={() => onOpenGroup(g.id)}
              style={{ padding: 12, cursor: 'pointer', borderLeft: `6px solid ${g.color || WF.ink2}` }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ width: 12, height: 12, background: g.color || WF.ink2, border: inkBorder() }} />
                <L size={14} weight={700}>{g.name}</L>
                {flagged && <Chip bg={WF.heat4} color={WF.onAccent}>⚑ flagged</Chip>}
                <div style={{ flex: 1 }} />
                <L mono size={10} color={WF.ink3}>{members.length} item{members.length === 1 ? '' : 's'} · {notes.length} annotation{notes.length === 1 ? '' : 's'}</L>
              </div>
              {members.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {members.map((key) => {
                    const d = describe(key);
                    if (!d) return null;
                    return (
                      <Chip
                        key={key}
                        onClick={d.exists && d.open ? (e) => { e.stopPropagation(); d.open(); } : undefined}
                        style={{ cursor: d.exists && d.open ? 'pointer' : 'default', opacity: d.exists ? 1 : 0.6, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}
                        title={`${d.kind} · ${anon(d.sublabel)}`}
                      >{d.icon} {anon(d.label)}</Chip>
                    );
                  })}
                </div>
              )}
              {notes.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                  {notes.map((n) => (
                    <div key={n.id} style={{ padding: 6, borderLeft: `3px solid ${WF.ink}`, background: WF.paperAlt }}>
                      <L size={12} style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{n.text}</L>
                    </div>
                  ))}
                </div>
              )}
            </Box>
          );
        })}
      </div>
    </section>
  );
}

function Stat({ n, label, color }) {
  return (
    <Box style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 120 }}>
      <L size={22} weight={700} color={color}>{n}</L>
      <L mono size={10} color={WF.ink3}>{label}</L>
    </Box>
  );
}

function SummaryBar({ flagged, notes, groups, total, onExport }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <Stat n={flagged} label="flagged" color={WF.heat4} />
      <Stat n={notes} label="user notes" color={WF.ink2} />
      <Stat n={groups} label="user groups" color={WF.ink2} />
      <Stat n={total} label="commits total" color={WF.ink2} />
      <div style={{ flex: 1 }} />
      <Chip
        style={{ cursor: 'pointer', fontSize: 14, padding: '6px 12px', background: WF.ink, color: WF.paper }}
        onClick={onExport}
        title="download output JSON"
      >export audit JSON ↓</Chip>
    </div>
  );
}

// A grouped list. When `collapsible`, the header doubles as a disclosure
// toggle (a caret + click target) and the body is hidden until opened —
// `defaultOpen={false}` keeps the AI-suspicion group folded so the auditor's
// own flags/notes lead and the analysis output stays one click away.
function OverviewSection({ title, accent, chunks, empty, onOpen, onDismiss, showNotes, showSuspicions, dimmed, collapsible, defaultOpen = true }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const expanded = !collapsible || open;
  return (
    <section>
      <div
        onClick={collapsible ? () => setOpen((v) => !v) : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 8,
          cursor: collapsible ? 'pointer' : 'default',
          userSelect: 'none',
        }}
      >
        {collapsible && <L mono size={12} color={WF.ink3}>{open ? '▾' : '▸'}</L>}
        <div style={{ width: 14, height: 14, background: accent, border: inkBorder() }} />
        <L size={16} weight={700}>{title}</L>
        <Chip>{chunks.length}</Chip>
      </div>
      {expanded && (
        <>
          {chunks.length === 0 && (
            <L size={12} color={WF.ink3} style={{ display: 'block', paddingLeft: 24, fontStyle: 'italic' }}>{empty}</L>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {chunks.map((c) => (
              <OverviewRow key={c._groupKey || c._semKey || c.id} chunk={c} onOpen={onOpen} onDismiss={onDismiss} showNotes={showNotes} showSuspicions={showSuspicions} accent={accent} dimmed={dimmed} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function OverviewRow({ chunk, onOpen, onDismiss, showNotes, showSuspicions, accent, dimmed }) {
  const { groupTagsOverlay = {} } = useData();
  const anon = useAnonymize();
  // A dismissed suspicion row reads as "cleared": the warning heat is desaturated
  // (heat4 → heat2) and the whole card softened, so it stays legible but plainly
  // demoted below the live suspicion queue.
  const susAccent = dimmed ? WF.heat2 : WF.heat4;
  const tagged = (groupTagsOverlay[rowTargetKey(chunk)] || []).length > 0;
  return (
    <Box
      onClick={() => onOpen(chunk)}
      style={{
        padding: 12,
        cursor: 'pointer',
        borderLeft: `6px solid ${accent}`,
        boxShadow: chunk.flagged ? `3px 3px 0 ${WF.shadow}` : undefined,
        opacity: dimmed ? 0.72 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Chip>{chunk.kind}</Chip>
        {chunk._isGroup && <Chip bg={WF.ink} color={WF.paper} title="this entry is a multi-commit group, not a single commit">group</Chip>}
        {chunk._isArea && <Chip bg={WF.ink} color={WF.paper} title="this entry is a flagged area on the semantic-areas screen">area</Chip>}
        {chunk._isThread && <Chip bg={WF.ink} color={WF.paper} title="this entry is a semantic thread on the semantic-areas screen">🧵 thread</Chip>}
        {chunk._isDoc && <Chip bg={WF.ink} color={WF.paper} title="this entry is a result document on the final-results screen">📄 document</Chip>}
        {chunk._isPlot && <Chip bg={WF.ink} color={WF.paper} title="this entry is a result plot on the final-results screen">🖼 plot</Chip>}
        <Sha sha={chunk.sha} size={12} color={WF.ink3} />
        {chunk.file && <L mono size={11} color={WF.ink2}>{anon(chunk.file)}</L>}
        {chunk.flag && <Chip bg={WF.paperAlt} color={WF.ink2} title="heuristic note (not a verdict): a results file was produced then later deleted — common in normal iteration, and can also be a logging-process artifact">ⓘ note · {chunk.flag.kind}</Chip>}
        {chunk.userFlagged && !chunk.flag && <Chip bg={WF.userflag} color={WF.onAccent}>{chunk._isGroup ? 'group flagged' : chunk._isArea ? 'area flagged' : chunk._isThread ? 'thread flagged' : chunk._isDoc ? 'document flagged' : chunk._isPlot ? 'plot flagged' : 'user flagged'}</Chip>}
        {dimmed && <Chip bg={WF.paperAlt} color={WF.ink2}>dismissed</Chip>}
        <div style={{ flex: 1 }} />
        {showSuspicions && onDismiss && (
          <Chip
            onClick={(e) => { e.stopPropagation(); onDismiss(chunk.id); }}
            style={{ cursor: 'pointer', background: dimmed ? WF.paper : WF.paperAlt, color: WF.ink2 }}
            title={dimmed ? 'restore this suspicion to the active list' : 'dismiss: I looked, this is fine'}
          >{dimmed ? '↩ restore' : '✕ dismiss'}</Chip>
        )}
        <Check on={chunk.visited} />
      </div>
      <L size={13} weight={600} style={{ display: 'block', marginTop: 6 }}>{anon(chunk.title)}</L>
      <L size={12} color={WF.ink2} style={{ display: 'block', marginTop: 2 }}>{anon(chunk.summary)}</L>
      {/* The user groups this item was tagged into — clicking a chip jumps to
          that group on the semantic-areas screen. */}
      {tagged && (
        <div style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
          <GroupTagChips targetKey={rowTargetKey(chunk)} />
        </div>
      )}
      {showSuspicions && (chunk.suspicions || []).length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {chunk.suspicions.map((s, i) => (
            <div
              key={s.suspicion_id || i}
              style={{ padding: 8, borderLeft: `4px solid ${susAccent}`, background: dimmed ? WF.paperAlt : WF.tint }}
            >
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Chip bg={susAccent} color={WF.onAccent}>{s.flag_level}</Chip>
                <Chip>{s.category}</Chip>
                <L mono size={10} color={WF.ink3}>{anon(s.agent_id)}</L>
              </div>
              <L size={12} style={{ display: 'block', marginTop: 4, whiteSpace: 'pre-wrap' }}>{anon(s.commit_commentary)}</L>
            </div>
          ))}
        </div>
      )}
      {showNotes && (chunk.userNotes || []).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {(chunk.userNotes || []).map((n) => (
            <div
              key={n.id}
              style={{
                padding: 6,
                borderLeft: `3px solid ${WF.ink}`,
                background: WF.paperAlt,
              }}
            >
              <L size={12} style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{n.text}</L>
            </div>
          ))}
        </div>
      )}
      {!showNotes && (chunk.userNotes || []).length > 0 && (
        <L mono size={10} color={WF.ink3} style={{ display: 'block', marginTop: 6 }}>
          {chunk.userNotes.length} user note{chunk.userNotes.length === 1 ? '' : 's'}
        </L>
      )}
    </Box>
  );
}
