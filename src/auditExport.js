// Auditor annotation serializer — React-free, the single source of truth for
// turning the auditor's overlay state into parseable artifacts.
//
// Two consumers:
//   * the manual "export audit JSON" button (WireOverview) reuses the collect*
//     helpers below — its download blob shape is left untouched;
//   * the dev-server disk mirror (dataStore → POST /api/audit) uses
//     buildAuditModel + serializeAuditFiles to write the trace's own
//     <traceDir>/audit/ on change.
//
// The on-disk layout mirrors the AI-produced commit_builder_metadata/*.jsonl
// idiom so an agent can left-join the auditor's flags/notes onto the AI layer by
// inner_commit_sha. Records are keyed on the same canonical ids the AI sidecars
// use (inner_commit_sha / event_id / group_id / area_id / thread_id / doc_id),
// every record carries a `source` field, and the format is append-friendly JSONL
// so a local agent can later contribute `source:"local_ai"` records of its own.
import { RESULTS_DOCS, docKey, PLOT_FILES, plotKey } from './WireResults.jsx';
import { usergroupKey, reverseTagIndex } from './Tagging.jsx';

// Humanize a plot filename for display (mirrors WireResults' humanizePlot).
export const humanizePlotFile = (file) => file.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');

// ── Shared markup collectors ────────────────────────────────────────────────
// Each bundles the auditor markups attached to a non-commit target (a sidecar
// group, a flagged area / thread, a result doc / plot) into a commit-shaped
// descriptor, reading flag + notes off the namespaced overlay keys. Kept here so
// the overview UI and the export share one definition.

// Sidecar groups carrying group-level markups (`group:<id>` overlay keys).
export function collectGroupMarkups(chunks, flaggedOverlay, userNotesOverlay) {
  const byId = new Map();
  for (const c of chunks) {
    if (!c.groupId) continue;
    if (!byId.has(c.groupId)) byId.set(c.groupId, []);
    byId.get(c.groupId).push(c);
  }
  const out = [];
  for (const [gid, members] of byId.entries()) {
    if (members.length < 2) continue;
    const key = `group:${gid}`;
    const userFlagged = !!flaggedOverlay[key];
    const userNotes = userNotesOverlay[key] || [];
    if (!userFlagged && userNotes.length === 0) continue;
    const m0 = members[0];
    const mN = members[members.length - 1];
    out.push({
      // navigate to the first member commit; the dossier groups it back up.
      id: m0.id,
      _groupKey: key,
      _groupId: gid,
      _isGroup: true,
      _lastSha: mN.sha || null,
      kind: m0.groupKind ? `group · ${m0.groupKind}` : 'group',
      sha: m0.sha,
      file: m0.groupRoot || null,
      title: m0.groupRoot || '(group)',
      summary: `group of ${members.length} commits · ${m0.sha ? m0.sha.slice(0, 7) : '?'} … ${mN.sha ? mN.sha.slice(0, 7) : '?'}`,
      flagged: userFlagged,
      userFlagged,
      userNotes,
      visited: members.every((m) => m.visited),
    });
  }
  return out;
}

// Flagged semantic areas / threads carrying markups (`area:<id>` / `thread:<id>`).
export function collectSemanticMarkups(semanticAreas, threads, flaggedOverlay, userNotesOverlay) {
  const out = [];
  for (const a of semanticAreas || []) {
    const key = `area:${a.area_id}`;
    const userFlagged = !!flaggedOverlay[key];
    const userNotes = userNotesOverlay[key] || [];
    if (!userFlagged && userNotes.length === 0) continue;
    out.push({
      id: key,                                    // synthetic id; never routed as a chunk id
      _semKey: key,
      _isArea: true,
      _areaId: a.area_id,
      _anchorSha: a.anchor_sha || null,
      _category: a.category || null,
      _flagLevel: a.flag_level || null,
      _commitCount: (a.commit_shas || []).length,
      kind: 'area',
      sha: a.anchor_sha || null,
      file: null,
      title: a.title || '(flagged area)',
      summary: `flagged area · ${(a.commit_shas || []).length} commits${a.category ? ' · ' + a.category : ''}${a.flag_level ? ' · ' + a.flag_level : ''}`,
      flagged: userFlagged,
      userFlagged,
      userNotes,
      visited: false,
    });
  }
  for (const t of threads || []) {
    const key = `thread:${t.thread_id}`;
    const userFlagged = !!flaggedOverlay[key];
    const userNotes = userNotesOverlay[key] || [];
    if (!userFlagged && userNotes.length === 0) continue;
    out.push({
      id: key,
      _semKey: key,
      _isThread: true,
      _threadId: t.thread_id,
      _theme: t.theme || null,
      _commitCount: (t.commit_shas || []).length,
      kind: 'thread',
      sha: null,
      file: null,
      title: t.label || '(thread)',
      summary: `thread · ${(t.commit_shas || []).length} commits${t.theme ? ' · ' + t.theme : ''}`,
      flagged: userFlagged,
      userFlagged,
      userNotes,
      visited: false,
    });
  }
  return out;
}

// Result-document markups (`doc:<id>` overlay keys).
export function collectDocMarkups(flaggedOverlay, userNotesOverlay) {
  const out = [];
  for (const d of RESULTS_DOCS) {
    const key = docKey(d.id);
    const userFlagged = !!flaggedOverlay[key];
    const userNotes = userNotesOverlay[key] || [];
    if (!userFlagged && userNotes.length === 0) continue;
    out.push({
      id: key,                                    // synthetic id; never routed as a chunk id
      _docKey: key,
      _isDoc: true,
      _docId: d.id,
      kind: 'document',
      sha: null,
      file: d.path || null,
      title: d.label,
      summary: `result artifact${d.path ? ' · ' + d.path : ''}`,
      flagged: userFlagged,
      userFlagged,
      userNotes,
      visited: false,
    });
  }
  return out;
}

// Per-plot markups (`plot:<file>` overlay keys).
export function collectPlotMarkups(flaggedOverlay, userNotesOverlay) {
  const out = [];
  for (const file of PLOT_FILES) {
    const key = plotKey(file);
    const userFlagged = !!flaggedOverlay[key];
    const userNotes = userNotesOverlay[key] || [];
    if (!userFlagged && userNotes.length === 0) continue;
    out.push({
      id: key,                                    // synthetic id; never routed as a chunk id
      _plotKey: key,
      _isPlot: true,
      _plotFile: file,
      kind: 'plot',
      sha: null,
      file: `main_results/${file}`,
      title: humanizePlotFile(file),
      summary: `result plot · ${file}`,
      flagged: userFlagged,
      userFlagged,
      userNotes,
      visited: false,
    });
  }
  return out;
}

// ── Pure target resolver ────────────────────────────────────────────────────
// Mirror of Tagging's useDescribeTarget, minus the navigation actions — resolves
// a membership target key back to { kind, label, inner_commit_sha } for the
// user_groups member list. Reads against the ungated dataset (rawData).
export function describeTargetLabel(data, targetKey) {
  if (!targetKey) return { kind: null, label: targetKey, inner_commit_sha: null };
  const { byId = {}, chunks = [], semanticAreas = [], threads = [] } = data || {};
  const colon = targetKey.indexOf(':');
  const prefix = colon > 0 ? targetKey.slice(0, colon) : '';
  const rest = colon > 0 ? targetKey.slice(colon + 1) : targetKey;
  if (prefix === 'group') {
    const members = chunks.filter((c) => c.groupId === rest);
    const m0 = members[0];
    return { kind: 'group', label: m0?.groupRoot || m0?.file || rest, inner_commit_sha: m0?.sha || null };
  }
  if (prefix === 'area') {
    const a = semanticAreas.find((x) => x.area_id === rest);
    return { kind: 'area', label: a?.title || rest, inner_commit_sha: a?.anchor_sha || null };
  }
  if (prefix === 'thread') {
    const t = threads.find((x) => x.thread_id === rest);
    return { kind: 'thread', label: t?.label || rest, inner_commit_sha: null };
  }
  if (prefix === 'doc') return { kind: 'doc', label: rest.replace(/_/g, ' '), inner_commit_sha: null };
  if (prefix === 'plot') return { kind: 'plot', label: humanizePlotFile(rest), inner_commit_sha: null };
  if (prefix === 'usergroup') return { kind: 'usergroup', label: rest, inner_commit_sha: null };
  const c = byId[targetKey];
  return { kind: 'commit', label: c?.title || c?.file || targetKey, inner_commit_sha: c?.sha || null };
}

const mapNotes = (notes) => (notes || []).map((n) => ({
  note_id: n.id, text: n.text, created_at: isoOrNull(n.createdAt), edited_at: isoOrNull(n.editedAt),
}));

function isoOrNull(ms) {
  if (ms == null) return null;
  try { return new Date(ms).toISOString(); } catch { return null; }
}

// ── Model + file serialization ──────────────────────────────────────────────
// buildAuditModel turns (base dataset + overlay maps) into a normalized model.
// It reads the same overlay maps the live UI uses, so it does not need the
// overlay-merged chunks — it filters base chunks by the flag/note overlays
// directly, exactly as the export collectors do.
export function buildAuditModel({ trace, data, overlays }) {
  const { chunks = [], byId = {}, semanticAreas = [], threads = [], meta = {}, coverage = {} } = data || {};
  const { flagged = {}, notes = {}, dismissed = {}, groups = {}, tags = {} } = overlays || {};

  const groupMarkups = collectGroupMarkups(chunks, flagged, notes);
  const semanticMarkups = collectSemanticMarkups(semanticAreas, threads, flagged, notes);
  const docMarkups = collectDocMarkups(flagged, notes);
  const plotMarkups = collectPlotMarkups(flagged, notes);
  const memberIndex = reverseTagIndex(tags);
  const taggedGroupsFor = (key) => (tags[key] || []).map((id) => groups[id]?.name).filter(Boolean);

  const commits = chunks
    .filter((c) => flagged[c.id] || (notes[c.id] || []).length > 0)
    .map((c) => ({
      target_kind: 'commit',
      event_id: c.id,
      inner_commit_sha: c.sha || null,
      kind: c.kind,
      file: c.file || null,
      user_flagged: !!flagged[c.id],
      tagged_groups: taggedGroupsFor(c.id),
      notes: mapNotes(c.id ? notes[c.id] : null),
    }));

  const groupItems = groupMarkups.map((g) => ({
    target_kind: 'group',
    group_id: g._groupId,
    inner_commit_sha: g.sha || null,
    last_sha: g._lastSha || null,
    root: g.file || null,
    user_flagged: !!g.userFlagged,
    tagged_groups: taggedGroupsFor(g._groupKey),
    notes: mapNotes(g.userNotes),
  }));

  const semantic = semanticMarkups.map((m) => ({
    target_kind: m._isArea ? 'area' : 'thread',
    area_id: m._isArea ? m._areaId : undefined,
    thread_id: m._isThread ? m._threadId : undefined,
    inner_commit_sha: m._anchorSha || null,
    title: m.title,
    category: m._category || null,
    theme: m._theme || null,
    commit_count: m._commitCount || 0,
    user_flagged: !!m.userFlagged,
    tagged_groups: taggedGroupsFor(m._semKey),
    notes: mapNotes(m.userNotes),
  }));

  const documents = docMarkups.map((m) => ({
    target_kind: 'doc',
    doc_id: m._docId,
    title: m.title,
    path: m.file || null,
    user_flagged: !!m.userFlagged,
    tagged_groups: taggedGroupsFor(m._docKey),
    notes: mapNotes(m.userNotes),
  }));

  const plots = plotMarkups.map((m) => ({
    target_kind: 'plot',
    plot_file: m._plotFile,
    title: m.title,
    path: m.file || null,
    user_flagged: !!m.userFlagged,
    tagged_groups: taggedGroupsFor(m._plotKey),
    notes: mapNotes(m.userNotes),
  }));

  const userGroups = Object.values(groups)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map((g) => ({
      group_id: g.id,
      name: g.name,
      color: g.color || null,
      created_at: isoOrNull(g.createdAt),
      user_flagged: !!flagged[usergroupKey(g.id)],
      annotations: mapNotes(notes[usergroupKey(g.id)]),
      members: (memberIndex[g.id] || []).map((key) => {
        const d = describeTargetLabel(data, key);
        return { target_key: key, kind: d.kind, label: d.label, inner_commit_sha: d.inner_commit_sha };
      }),
    }));

  // Dismissals: keys are bare commit ids, or `area:`/`thread:` tokens. Resolve a
  // commit id to its sha so the dismissal joins back onto the AI suspicion layer.
  const dismissals = Object.keys(dismissed)
    .filter((k) => dismissed[k])
    .map((key) => {
      const colon = key.indexOf(':');
      if (colon > 0) {
        const prefix = key.slice(0, colon);
        const rest = key.slice(colon + 1);
        if (prefix === 'area') return { target_kind: 'area', area_id: rest, inner_commit_sha: null };
        if (prefix === 'thread') return { target_kind: 'thread', thread_id: rest, inner_commit_sha: null };
        return { target_kind: prefix, id: rest, inner_commit_sha: null };
      }
      return { target_kind: 'commit', event_id: key, inner_commit_sha: byId[key]?.sha || null };
    });

  const flagCount = commits.filter((c) => c.user_flagged).length
    + groupItems.filter((g) => g.user_flagged).length
    + semantic.filter((m) => m.user_flagged).length
    + documents.filter((m) => m.user_flagged).length
    + plots.filter((m) => m.user_flagged).length;

  const visitedCount = chunks.filter((c) => c.visited).length;

  return {
    trace: trace || meta.experiment || null,
    session: {
      experiment: meta.experiment || null,
      commit_count: meta.eventCount ?? chunks.length,
      flag_count: flagCount,
    },
    coverage: { visited: coverage.visited ?? visitedCount, total: coverage.total ?? chunks.length },
    commits,
    groups: groupItems,
    semantic,
    documents,
    plots,
    userGroups,
    dismissals,
  };
}

const SOURCE = 'auditor';
const jsonl = (records) => (records.length ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
const stamp = (trace, obj) => ({ source: SOURCE, trace, ...obj });

// serializeAuditFiles → { '<relative path>': '<file content>' }. Keys are the
// fixed set the dev-server endpoint allowlists; subdirs separate auditor items
// (user/) from review status (status/). The local_ai/ subdir is owned by the
// local agent and is never written here.
export function serializeAuditFiles(model) {
  const trace = model.trace;
  const exportedAt = new Date().toISOString();

  // user/user_flags.jsonl — one record per flagged target (notes stripped).
  const flagRecords = [];
  for (const c of model.commits) if (c.user_flagged) {
    flagRecords.push(stamp(trace, { target_kind: 'commit', event_id: c.event_id, inner_commit_sha: c.inner_commit_sha, file: c.file, tagged_groups: c.tagged_groups }));
  }
  for (const g of model.groups) if (g.user_flagged) {
    flagRecords.push(stamp(trace, { target_kind: 'group', group_id: g.group_id, inner_commit_sha: g.inner_commit_sha, last_sha: g.last_sha, root: g.root, tagged_groups: g.tagged_groups }));
  }
  for (const m of model.semantic) if (m.user_flagged) {
    flagRecords.push(stamp(trace, { target_kind: m.target_kind, area_id: m.area_id, thread_id: m.thread_id, inner_commit_sha: m.inner_commit_sha, title: m.title, tagged_groups: m.tagged_groups }));
  }
  for (const m of model.documents) if (m.user_flagged) {
    flagRecords.push(stamp(trace, { target_kind: 'doc', doc_id: m.doc_id, path: m.path, tagged_groups: m.tagged_groups }));
  }
  for (const m of model.plots) if (m.user_flagged) {
    flagRecords.push(stamp(trace, { target_kind: 'plot', plot_file: m.plot_file, path: m.path, tagged_groups: m.tagged_groups }));
  }

  // user/user_notes.jsonl — one record per note, across every target kind.
  const noteRecords = [];
  const pushNotes = (item, idFields) => {
    for (const n of item.notes || []) {
      noteRecords.push(stamp(trace, { note_id: n.note_id, ...idFields, tagged_groups: item.tagged_groups, text: n.text, created_at: n.created_at, edited_at: n.edited_at }));
    }
  };
  for (const c of model.commits) pushNotes(c, { target_kind: 'commit', event_id: c.event_id, inner_commit_sha: c.inner_commit_sha });
  for (const g of model.groups) pushNotes(g, { target_kind: 'group', group_id: g.group_id, inner_commit_sha: g.inner_commit_sha });
  for (const m of model.semantic) pushNotes(m, { target_kind: m.target_kind, area_id: m.area_id, thread_id: m.thread_id, inner_commit_sha: m.inner_commit_sha });
  for (const m of model.documents) pushNotes(m, { target_kind: 'doc', doc_id: m.doc_id });
  for (const m of model.plots) pushNotes(m, { target_kind: 'plot', plot_file: m.plot_file });

  // user/user_groups.jsonl — the auditor's grouping registry, members + notes.
  const groupRecords = model.userGroups.map((g) => stamp(trace, {
    group_id: g.group_id, name: g.name, color: g.color, created_at: g.created_at,
    user_flagged: g.user_flagged, annotations: g.annotations, members: g.members,
  }));

  // status/user_dismissals.jsonl — AI suspicions the auditor reviewed + cleared.
  const dismissalRecords = model.dismissals.map((d) => stamp(trace, d));

  const coverage = stamp(trace, {
    exported_at: exportedAt,
    session: model.session,
    coverage: model.coverage,
  });

  return {
    'user/user_flags.jsonl': jsonl(flagRecords),
    'user/user_notes.jsonl': jsonl(noteRecords),
    'user/user_groups.jsonl': jsonl(groupRecords),
    'status/user_dismissals.jsonl': jsonl(dismissalRecords),
    'status/coverage.json': JSON.stringify(coverage, null, 2) + '\n',
    'AI_AUDIT.md': renderAuditMarkdown(model, exportedAt),
  };
}

// ── Markdown digest ─────────────────────────────────────────────────────────
const sha7 = (s) => (s ? s.slice(0, 7) : '—');

export function renderAuditMarkdown(model, exportedAt) {
  const L = [];
  L.push(`# Audit notes — ${model.trace || 'trace'}`);
  L.push('');
  L.push('> Auditor-authored hints, mirrored from the audit UI. Not ground truth —');
  L.push('> confirm against the logs and the diffs in `codebase/`.');
  L.push('');
  L.push(`- Coverage: ${model.coverage.visited}/${model.coverage.total} commits visited`);
  L.push(`- Flagged: ${model.session.flag_count}`);
  if (exportedAt) L.push(`- Last synced: ${exportedAt}`);
  L.push('');

  const flaggedCommits = model.commits.filter((c) => c.user_flagged);
  const flaggedGroups = model.groups.filter((g) => g.user_flagged);
  const flaggedSemantic = model.semantic.filter((m) => m.user_flagged);
  const flaggedDocs = [...model.documents, ...model.plots].filter((m) => m.user_flagged);
  if (flaggedCommits.length || flaggedGroups.length || flaggedSemantic.length || flaggedDocs.length) {
    L.push('## Flagged');
    L.push('');
    L.push('| kind | ref | what | groups |');
    L.push('| --- | --- | --- | --- |');
    for (const c of flaggedCommits) L.push(`| commit | \`${sha7(c.inner_commit_sha)}\` | ${esc(c.file || c.kind)} | ${esc(c.tagged_groups.join(', '))} |`);
    for (const g of flaggedGroups) L.push(`| group | \`${sha7(g.inner_commit_sha)}…${sha7(g.last_sha)}\` | ${esc(g.root || g.group_id)} | ${esc(g.tagged_groups.join(', '))} |`);
    for (const m of flaggedSemantic) L.push(`| ${m.target_kind} | ${esc(m.area_id || m.thread_id)} | ${esc(m.title)} | ${esc(m.tagged_groups.join(', '))} |`);
    for (const m of flaggedDocs) L.push(`| ${m.target_kind} | ${esc(m.doc_id || m.plot_file)} | ${esc(m.title)} | ${esc(m.tagged_groups.join(', '))} |`);
    L.push('');
  }

  const withNotes = [...model.commits, ...model.groups, ...model.semantic, ...model.documents, ...model.plots]
    .filter((x) => (x.notes || []).length > 0);
  if (withNotes.length) {
    L.push('## Notes');
    L.push('');
    for (const item of withNotes) {
      const ref = item.inner_commit_sha ? `\`${sha7(item.inner_commit_sha)}\`` : (item.area_id || item.thread_id || item.doc_id || item.plot_file || item.group_id || '');
      const label = item.file || item.title || item.target_kind;
      L.push(`### ${item.target_kind} ${ref} — ${esc(label)}`);
      for (const n of item.notes) L.push(`- ${esc(n.text)}`);
      L.push('');
    }
  }

  if (model.userGroups.length) {
    L.push('## User groups');
    L.push('');
    for (const g of model.userGroups) {
      L.push(`### ${esc(g.name)}${g.user_flagged ? ' ⚑' : ''} (${g.members.length} item${g.members.length === 1 ? '' : 's'})`);
      for (const m of g.members) {
        const ref = m.inner_commit_sha ? ` \`${sha7(m.inner_commit_sha)}\`` : '';
        L.push(`- ${m.kind}: ${esc(m.label)}${ref}`);
      }
      for (const n of g.annotations) L.push(`  - note: ${esc(n.text)}`);
      L.push('');
    }
  }

  if (model.dismissals.length) {
    L.push('## Dismissed AI suspicions');
    L.push('');
    L.push('_The auditor reviewed these and cleared them — do not re-raise unprompted._');
    L.push('');
    for (const d of model.dismissals) {
      const ref = d.inner_commit_sha ? `\`${sha7(d.inner_commit_sha)}\`` : (d.area_id || d.thread_id || d.id || '');
      L.push(`- ${d.target_kind} ${ref}`);
    }
    L.push('');
  }

  return L.join('\n');
}

const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
