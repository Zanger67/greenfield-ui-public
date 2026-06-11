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
// On-disk layout (schema_version 2): one file per KIND under items/, one record
// per item with its annotations inlined; the auditor's user-groups live under
// groups/ as a thin index of pure target_key pointers into those items. Every
// record carries a uniform `target_key` (`<kind>:<id>`) plus `schema_version` +
// `source` + `trace`, so an agent joins across files by one key and joins onto
// the AI commit_builder_metadata/ layer + git by `inner_commit_sha` / `event_id`
// / `thread_id` / `area_id` / `group_id`. JSONL is append-friendly so a local
// agent can contribute `source:"local_ai"` records under local_ai/.
import { RESULTS_DOCS, docKey, PLOT_FILES, plotKey } from './WireResults.jsx';
import { usergroupKey, reverseTagIndex } from './Tagging.jsx';

export const SCHEMA_VERSION = 2;

// Humanize a plot filename for display (mirrors WireResults' humanizePlot).
export const humanizePlotFile = (file) => file.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');

// Default for the collect* `includeKeys` param — the set of overlay keys to emit
// even when neither flagged nor noted (used by buildAuditModel to realize items
// that are only tagged into a user-group). The UI/export call sites omit it, so
// their behavior is unchanged.
const EMPTY_KEYS = new Set();

// ── Shared markup collectors ────────────────────────────────────────────────
// Each bundles the auditor markups attached to a non-commit target (a sidecar
// group, a flagged area / thread, a result doc / plot) into a commit-shaped
// descriptor, reading flag + notes off the namespaced overlay keys. Kept here so
// the overview UI and the export share one definition. `includeKeys` widens the
// gate so a target tagged into a user-group (but not flagged/noted) is still
// emitted — otherwise a group's pointer to it would dangle.

// Sidecar groups carrying group-level markups (`group:<id>` overlay keys).
export function collectGroupMarkups(chunks, flaggedOverlay, userNotesOverlay, includeKeys = EMPTY_KEYS) {
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
    if (!userFlagged && userNotes.length === 0 && !includeKeys.has(key)) continue;
    const m0 = members[0];
    const mN = members[members.length - 1];
    out.push({
      // navigate to the first member commit; the dossier groups it back up.
      id: m0.id,
      _groupKey: key,
      _groupId: gid,
      _isGroup: true,
      _lastSha: mN.sha || null,
      _groupKind: m0.groupKind || null,
      _commitShas: members.map((m) => m.sha).filter(Boolean),
      _commitCount: members.length,
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
export function collectSemanticMarkups(semanticAreas, threads, flaggedOverlay, userNotesOverlay, includeKeys = EMPTY_KEYS) {
  const out = [];
  for (const a of semanticAreas || []) {
    const key = `area:${a.area_id}`;
    const userFlagged = !!flaggedOverlay[key];
    const userNotes = userNotesOverlay[key] || [];
    if (!userFlagged && userNotes.length === 0 && !includeKeys.has(key)) continue;
    out.push({
      id: key,                                    // synthetic id; never routed as a chunk id
      _semKey: key,
      _isArea: true,
      _areaId: a.area_id,
      _anchorSha: a.anchor_sha || null,
      _category: a.category || null,
      _flagLevel: a.flag_level || null,
      _commitShas: (a.commit_shas || []).filter(Boolean),
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
    if (!userFlagged && userNotes.length === 0 && !includeKeys.has(key)) continue;
    out.push({
      id: key,
      _semKey: key,
      _isThread: true,
      _threadId: t.thread_id,
      _theme: t.theme || null,
      _commitShas: (t.commit_shas || []).filter(Boolean),
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
export function collectDocMarkups(flaggedOverlay, userNotesOverlay, includeKeys = EMPTY_KEYS) {
  const out = [];
  for (const d of RESULTS_DOCS) {
    const key = docKey(d.id);
    const userFlagged = !!flaggedOverlay[key];
    const userNotes = userNotesOverlay[key] || [];
    if (!userFlagged && userNotes.length === 0 && !includeKeys.has(key)) continue;
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
export function collectPlotMarkups(flaggedOverlay, userNotesOverlay, includeKeys = EMPTY_KEYS) {
  const out = [];
  for (const file of PLOT_FILES) {
    const key = plotKey(file);
    const userFlagged = !!flaggedOverlay[key];
    const userNotes = userNotesOverlay[key] || [];
    if (!userFlagged && userNotes.length === 0 && !includeKeys.has(key)) continue;
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
// a membership target key back to { kind, label, inner_commit_sha }. Kept for
// label resolution by any consumer that wants a human string for a target key.
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
// It reads the same overlay maps the live UI uses, filtering base chunks by the
// flag/note/tag overlays directly. Each item carries its uniform `target_key`,
// its annotations inline, and the group ids/names it's tagged into; user-groups
// carry typed pointer buckets + a derived `commit_shas` rollup.
export function buildAuditModel({ trace, data, overlays }) {
  const { chunks = [], byId = {}, semanticAreas = [], threads = [], meta = {}, coverage = {} } = data || {};
  const { flagged = {}, notes = {}, dismissed = {}, groups = {}, tags = {} } = overlays || {};

  // Overlay keys that carry ≥1 group tag — used to realize items that are only
  // tagged into a user-group (so the group's pointer to them resolves). Keys are
  // the overlay's own: bare event_id for commits, namespaced for everything else.
  const taggedKeys = new Set(Object.keys(tags).filter((k) => (tags[k] || []).length > 0));

  const groupMarkups = collectGroupMarkups(chunks, flagged, notes, taggedKeys);
  const semanticMarkups = collectSemanticMarkups(semanticAreas, threads, flagged, notes, taggedKeys);
  const docMarkups = collectDocMarkups(flagged, notes, taggedKeys);
  const plotMarkups = collectPlotMarkups(flagged, notes, taggedKeys);
  const memberIndex = reverseTagIndex(tags);
  // tags is keyed by the overlay key (bare event_id for commits, namespaced
  // otherwise); pass that exact key here, not the emitted `commit:<id>` form.
  const groupIdsFor = (key) => (tags[key] || []).slice();
  const groupNamesFor = (key) => (tags[key] || []).map((id) => groups[id]?.name).filter(Boolean);

  const commits = chunks
    .filter((c) => flagged[c.id] || (notes[c.id] || []).length > 0 || taggedKeys.has(c.id))
    .map((c) => ({
      target_kind: 'commit',
      target_key: `commit:${c.id}`,
      event_id: c.id,
      inner_commit_sha: c.sha || null,
      kind: c.kind,
      file: c.file || null,
      flagged: !!flagged[c.id],
      tagged_group_ids: groupIdsFor(c.id),
      tagged_group_names: groupNamesFor(c.id),
      notes: mapNotes(notes[c.id]),
    }));

  const groupItems = groupMarkups.map((g) => ({
    target_kind: 'group',
    target_key: g._groupKey,
    group_id: g._groupId,
    inner_commit_sha: g.sha || null,
    last_sha: g._lastSha || null,
    commit_shas: g._commitShas || [],
    root: g.file || null,
    group_kind: g._groupKind || null,
    commit_count: g._commitCount || 0,
    flagged: !!g.userFlagged,
    tagged_group_ids: groupIdsFor(g._groupKey),
    tagged_group_names: groupNamesFor(g._groupKey),
    notes: mapNotes(g.userNotes),
  }));

  const semantic = semanticMarkups.map((m) => ({
    target_kind: m._isArea ? 'area' : 'thread',
    target_key: m._semKey,
    area_id: m._isArea ? m._areaId : undefined,
    thread_id: m._isThread ? m._threadId : undefined,
    anchor_sha: m._isArea ? (m._anchorSha || null) : undefined,
    inner_commit_sha: m._anchorSha || null,
    commit_shas: m._commitShas || [],
    title: m.title,
    category: m._category || null,
    theme: m._theme || null,
    commit_count: m._commitCount || 0,
    flagged: !!m.userFlagged,
    tagged_group_ids: groupIdsFor(m._semKey),
    tagged_group_names: groupNamesFor(m._semKey),
    notes: mapNotes(m.userNotes),
  }));

  const documents = docMarkups.map((m) => ({
    target_kind: 'doc',
    target_key: m._docKey,
    doc_id: m._docId,
    inner_commit_sha: null,
    title: m.title,
    path: m.file || null,
    flagged: !!m.userFlagged,
    tagged_group_ids: groupIdsFor(m._docKey),
    tagged_group_names: groupNamesFor(m._docKey),
    notes: mapNotes(m.userNotes),
  }));

  const plots = plotMarkups.map((m) => ({
    target_kind: 'plot',
    target_key: m._plotKey,
    plot_file: m._plotFile,
    inner_commit_sha: null,
    title: m.title,
    path: m.file || null,
    flagged: !!m.userFlagged,
    tagged_group_ids: groupIdsFor(m._plotKey),
    tagged_group_names: groupNamesFor(m._plotKey),
    notes: mapNotes(m.userNotes),
  }));

  // Index every realized item by its target_key, so user-group pointers resolve
  // and the commit_shas rollup can read member shas without re-deriving them.
  const itemByKey = new Map();
  for (const arr of [commits, groupItems, semantic, documents, plots]) {
    for (const it of arr) itemByKey.set(it.target_key, it);
  }

  // Classify an overlay member key into (emitted target_key, bucket). Commits
  // are stored bare in the overlay; namespace them to match items/commits.jsonl.
  const classifyMember = (key) => {
    if (key.startsWith('group:')) return { emitted: key, bucket: 'sidecar_groups' };
    if (key.startsWith('area:')) return { emitted: key, bucket: 'areas' };
    if (key.startsWith('thread:')) return { emitted: key, bucket: 'threads' };
    if (key.startsWith('doc:')) return { emitted: key, bucket: 'files' };
    if (key.startsWith('plot:')) return { emitted: key, bucket: 'plots' };
    if (key.startsWith('usergroup:')) return null;   // groups aren't tagged into groups
    return { emitted: `commit:${key}`, bucket: 'commits' };
  };

  const userGroups = Object.values(groups)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map((g) => {
      const members = { commits: [], threads: [], areas: [], files: [], plots: [], sidecar_groups: [] };
      for (const key of memberIndex[g.id] || []) {
        const cls = classifyMember(key);
        // Only keep pointers that resolve to a realized item record (drops
        // out-of-trace / stale tags), so no member pointer ever dangles.
        if (cls && itemByKey.has(cls.emitted)) members[cls.bucket].push(cls.emitted);
      }
      for (const k of Object.keys(members)) members[k].sort();
      // Derived rollup: every commit hash this group transitively touches —
      // direct member commits' shas ∪ member containers' commit_shas.
      const shaSet = new Set();
      for (const ck of members.commits) {
        const sha = itemByKey.get(ck)?.inner_commit_sha;
        if (sha) shaSet.add(sha);
      }
      for (const ck of [...members.threads, ...members.areas, ...members.sidecar_groups]) {
        for (const s of itemByKey.get(ck)?.commit_shas || []) if (s) shaSet.add(s);
      }
      const member_count = Object.values(members).reduce((n, a) => n + a.length, 0);
      return {
        group_id: g.id,
        name: g.name,
        color: g.color || null,
        created_at: isoOrNull(g.createdAt),
        flagged: !!flagged[usergroupKey(g.id)],
        notes: mapNotes(notes[usergroupKey(g.id)]),
        members,
        member_count,
        commit_shas: [...shaSet].sort(),
      };
    });

  // Dismissals: keys are bare commit ids, or `area:`/`thread:`/`doc:`/`plot:`/
  // `group:` tokens. Resolve a commit id to its sha so the dismissal joins back
  // onto the AI suspicion layer; carry a uniform target_key like every record.
  const dismissals = Object.keys(dismissed)
    .filter((k) => dismissed[k])
    .map((key) => {
      const colon = key.indexOf(':');
      if (colon > 0) {
        const prefix = key.slice(0, colon);
        const rest = key.slice(colon + 1);
        if (prefix === 'area') return { target_kind: 'area', target_key: key, area_id: rest, inner_commit_sha: null };
        if (prefix === 'thread') return { target_kind: 'thread', target_key: key, thread_id: rest, inner_commit_sha: null };
        return { target_kind: prefix, target_key: key, id: rest, inner_commit_sha: null };
      }
      return { target_kind: 'commit', target_key: `commit:${key}`, event_id: key, inner_commit_sha: byId[key]?.sha || null };
    })
    .sort((a, b) => (a.target_key < b.target_key ? -1 : a.target_key > b.target_key ? 1 : 0));

  const flagCount = commits.filter((c) => c.flagged).length
    + groupItems.filter((g) => g.flagged).length
    + semantic.filter((m) => m.flagged).length
    + documents.filter((m) => m.flagged).length
    + plots.filter((m) => m.flagged).length;

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

// serializeAuditFiles → { '<relative path>': '<file content>' }. Keys are the
// fixed set the dev-server endpoint allowlists. items/ holds one file per kind
// (one record per item, notes inlined); groups/ the auditor's user-groups index;
// status/ review state; manifest.json the schema_version + inventory. The
// local_ai/ subdir is owned by the local agent and is never written here.
export function serializeAuditFiles(model) {
  const trace = model.trace;
  const exportedAt = new Date().toISOString();
  const stampV2 = (obj) => ({ schema_version: SCHEMA_VERSION, source: SOURCE, trace, ...obj });
  const lines = (arr) => jsonl(arr.map(stampV2));

  const areas = model.semantic.filter((m) => m.target_kind === 'area');
  const threadItems = model.semantic.filter((m) => m.target_kind === 'thread');

  const userGroupRecords = model.userGroups.map((g) => stampV2({
    group_id: g.group_id, name: g.name, color: g.color, created_at: g.created_at,
    flagged: g.flagged, notes: g.notes, members: g.members,
    member_count: g.member_count, commit_shas: g.commit_shas,
  }));

  const coverage = stampV2({
    exported_at: exportedAt,
    session: model.session,
    coverage: model.coverage,
  });

  const manifest = stampV2({
    generated_at: exportedAt,
    key_scheme: {
      format: '<kind>:<id>',
      kinds: { commit: 'event_id', thread: 'thread_id', area: 'area_id', doc: 'doc_id', plot: 'plot_file', group: 'sidecar group_id' },
    },
    files: {
      items: ['items/commits.jsonl', 'items/threads.jsonl', 'items/areas.jsonl', 'items/files.jsonl', 'items/plots.jsonl', 'items/sidecar_groups.jsonl'],
      groups: ['groups/user_groups.jsonl'],
      status: ['status/dismissals.jsonl', 'status/coverage.json'],
      digest: 'AI_AUDIT.md',
      local_ai_dir: 'local_ai/',
    },
    counts: {
      commits: model.commits.length,
      threads: threadItems.length,
      areas: areas.length,
      files: model.documents.length,
      plots: model.plots.length,
      sidecar_groups: model.groups.length,
      user_groups: model.userGroups.length,
      dismissals: model.dismissals.length,
    },
  });

  return {
    'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    'items/commits.jsonl': lines(model.commits),
    'items/threads.jsonl': lines(threadItems),
    'items/areas.jsonl': lines(areas),
    'items/files.jsonl': lines(model.documents),
    'items/plots.jsonl': lines(model.plots),
    'items/sidecar_groups.jsonl': lines(model.groups),
    'groups/user_groups.jsonl': jsonl(userGroupRecords),
    'status/dismissals.jsonl': jsonl(model.dismissals.map(stampV2)),
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

  const flaggedCommits = model.commits.filter((c) => c.flagged);
  const flaggedGroups = model.groups.filter((g) => g.flagged);
  const flaggedSemantic = model.semantic.filter((m) => m.flagged);
  const flaggedDocs = [...model.documents, ...model.plots].filter((m) => m.flagged);
  if (flaggedCommits.length || flaggedGroups.length || flaggedSemantic.length || flaggedDocs.length) {
    L.push('## Flagged');
    L.push('');
    L.push('| kind | ref | what | groups |');
    L.push('| --- | --- | --- | --- |');
    for (const c of flaggedCommits) L.push(`| commit | \`${sha7(c.inner_commit_sha)}\` | ${esc(c.file || c.kind)} | ${esc(c.tagged_group_names.join(', '))} |`);
    for (const g of flaggedGroups) L.push(`| group | \`${sha7(g.inner_commit_sha)}…${sha7(g.last_sha)}\` | ${esc(g.root || g.group_id)} | ${esc(g.tagged_group_names.join(', '))} |`);
    for (const m of flaggedSemantic) L.push(`| ${m.target_kind} | ${esc(m.area_id || m.thread_id)} | ${esc(m.title)} | ${esc(m.tagged_group_names.join(', '))} |`);
    for (const m of flaggedDocs) L.push(`| ${m.target_kind} | ${esc(m.doc_id || m.plot_file)} | ${esc(m.title)} | ${esc(m.tagged_group_names.join(', '))} |`);
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
    const BUCKETS = [['commits', 'commit'], ['threads', 'thread'], ['areas', 'area'], ['files', 'file'], ['plots', 'plot'], ['sidecar_groups', 'sidecar group']];
    for (const g of model.userGroups) {
      L.push(`### ${esc(g.name)}${g.flagged ? ' ⚑' : ''} (${g.member_count} item${g.member_count === 1 ? '' : 's'})`);
      for (const [bucket, label] of BUCKETS) {
        for (const key of g.members[bucket] || []) L.push(`- ${label}: \`${esc(key)}\``);
      }
      for (const n of g.notes) L.push(`  - note: ${esc(n.text)}`);
      if (g.commit_shas.length) L.push(`  - commits touched: ${g.commit_shas.map(sha7).join(', ')}`);
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
