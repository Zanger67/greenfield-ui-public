// Data store — loads the commit-based trace artifacts emitted by the
// sibling repo's commit-builder for a given trace:
//
//   event_commit_map.jsonl  — one record per event, with event_id, source
//      ('audit'|'commands'|'claude_tools'), ts, inner_commit_sha, and a
//      stringified raw_line containing the original event payload.
//   bash_index.jsonl        — pane/session context for `source: 'commands'`
//      events, joined by inner_commit_sha.
//   flags.jsonl             — pre-computed anomalies (add_then_remove,
//      run_scrapped), keyed by primary_sha.
//   commit_sidecar.jsonl    — deterministic per-commit classification, keyed
//      by sha: { mutating, group_id, group_size, group_index }. `mutating:
//      false` marks non-invasive (read-only) commits the inbox renders as a
//      compact, dimmed single line. Optional — older traces lack it.
//   annotations.jsonl       — descriptive "what is being done" notes from the
//      annotation_agent fleet, each targeting a commit (by inner_commit_sha)
//      or a sidecar group (by group_id). Optional. Joined onto commits and
//      surfaced in both the commit dossier and the group report.
//   thread_annotations.jsonl — semantic threads from the thread_agent: each is a
//      line of work { thread_id, label, commits[], direction, reasoning,
//      commit_beats[] } whose commits may be non-adjacent. Optional. Joined onto
//      commits (chunk.threads) for a "part of thread" box, and listed on the
//      semantic-areas screen below the flagged areas with progression.
//   semantic_clusters.jsonl — OPTIONAL explicit idea-clusters from a future
//      producer, each grouping commit_shas under one idea. A *second* source for
//      the "semantic areas" screen; the primary source is derived in-UI from
//      suspicions that link multiple commits (see deriveSemanticAreas). There is
//      deliberately no precomputed semantic_areas.jsonl — that derived file went
//      stale against re-emitted SHAs, so the grouping is now computed at load.
//
// Two on-disk layouts are supported per input:
//   * Dropped trace — the whole `output/<trace>/` folder copied verbatim
//     into public/data/<name>/, so the commit-builder artifacts live under
//     `commit_builder_metadata/` and the git repo under `codebase/`.
//   * Flat — every jsonl sits directly at public/data/<name>/ (the original
//     hand-assembled layout).
// Each artifact is fetched from its nested location first, then the flat
// root; the optional suspicion/rating files are tried at the root first
// since the raw trace doesn't carry them.
//
// The rest of the UI still consumes `data.chunks` / `data.coverage` /
// `data.byId` / `useData().navigate` etc.; this loader produces
// CommitRecord objects that satisfy that contract. The legacy chunk-graph
// loader has been removed since no consumer reads it any more.
import React from 'react';
// settings ↔ dataStore form an import cycle (settings.jsx reads useData for the
// reset-cache row; this reads useSettings for the AI-suspicion gate). Both uses
// are inside function bodies — evaluated at render, long after both modules
// finish loading — so the cycle resolves at runtime and never bites.
import { useSettings } from './settings.jsx';
import { buildAuditModel, serializeAuditFiles } from './auditExport.js';

const MANIFEST_URL = '/data/index.json';
const AUDIT_URL = '/api/audit';
const dataUrl = (name, file) => `/data/${name}/${file}`;

// Auditor markups (visited / user-flagged / notes / user groups) persist
// per-trace in localStorage so they survive trace swaps, hard reloads, and tab
// close. Keyed by trace name; position lives in history.state, markups live
// here. `groups` is the auditor's own user-group registry ({ id → { id, name,
// color, createdAt } }) and `tags` the membership map (targetKey → [groupId]),
// keyed by the same target keys flags use (a commit id, or a namespaced
// `group:`/`area:`/`thread:`/`doc:` key). A group's own annotations + flag reuse
// the notes/flagged overlays under a `usergroup:<id>` key, so they round-trip
// through the same storage and the same editors as every other markup.
const OVERLAY_KEY = (name) => `redlogs:overlays:${name}`;
const asObj = (v) => (v && typeof v === 'object' ? v : {});
const EMPTY_OVERLAYS = () => ({ visited: {}, flagged: {}, notes: {}, dismissed: {}, groups: {}, tags: {} });

function loadStoredOverlays(name) {
  if (!name) return EMPTY_OVERLAYS();
  try {
    const raw = localStorage.getItem(OVERLAY_KEY(name));
    const o = raw ? JSON.parse(raw) : {};
    return {
      visited: asObj(o.visited), flagged: asObj(o.flagged), notes: asObj(o.notes),
      dismissed: asObj(o.dismissed), groups: asObj(o.groups), tags: asObj(o.tags),
    };
  } catch {
    return EMPTY_OVERLAYS();
  }
}

function saveStoredOverlays(name, visited, flagged, notes, dismissed, groups, tags) {
  if (!name) return;
  try {
    localStorage.setItem(OVERLAY_KEY(name), JSON.stringify({ visited, flagged, notes, dismissed, groups, tags }));
  } catch { /* quota / disabled storage — markups stay in-memory this session */ }
}

// The last-selected trace also persists in localStorage. history.state already
// restores trace + position across a reload or back/forward, but it is gone on
// a true reopen (a fresh tab, or after the browser was closed). This durable
// key remembers just *which* trace, so a reopen lands on the trace the auditor
// was last on (at its default position) instead of defaulting to the first.
const LAST_INPUT_KEY = 'redlogs:last-input';
function loadLastInput() {
  try { return localStorage.getItem(LAST_INPUT_KEY) || null; } catch { return null; }
}
function saveLastInput(name) {
  if (!name) return;
  try { localStorage.setItem(LAST_INPUT_KEY, name); } catch { /* quota / disabled storage */ }
}

// Fetch the first candidate path under the input that responds 200.
async function fetchFirstOk(name, candidates) {
  let lastErr = null;
  for (const file of candidates) {
    const url = dataUrl(name, file);
    try {
      const r = await fetch(url);
      // Vite's dev SPA fallback answers a missing static file with index.html
      // at HTTP 200 (content-type: text/html). Treat that as a miss so the
      // next candidate (e.g. the nested commit_builder_metadata/ copy) is tried
      // instead of parsing HTML into an empty array — which silently wiped out
      // the flat-first suspicion/thread artifacts.
      const ct = r.headers.get('content-type') || '';
      if (r.ok && !ct.includes('text/html')) return r;
      lastErr = new Error(`${url} → ${r.status}${ct.includes('text/html') ? ' (spa fallback)' : ''}`);
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('no candidate path matched');
}

// commit-builder artifacts: nested (dropped trace) then flat (legacy).
const cbCandidates = (file) => [`commit_builder_metadata/${file}`, file];
// suspicion/rating artifacts: flat first (the raw trace doesn't bundle them),
// then nested as a courtesy if a producer dropped them alongside the rest.
const susCandidates = (file) => [file, `commit_builder_metadata/${file}`];

function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (err) { console.warn('skip bad jsonl line', err); }
  }
  return out;
}

function safeParseRawLine(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function deriveKind(source, rl) {
  if (source === 'commands') return 'BASH';
  if (source === 'claude_tools') {
    if (rl?.tool === 'Bash') return 'BASH';
    return 'TOOL';
  }
  // audit
  const action = (rl?.action || '').toLowerCase();
  if (action === 'created') return 'CREATE';
  if (action === 'modified') return 'MODIFY';
  if (action === 'deleted') return 'DELETE';
  if (action.startsWith('session')) return 'SESSION';
  if (action.startsWith('sync')) return 'SYNC';
  // SYNC reconciliation record has empty raw_line; fall back to id-shape.
  return 'SYNC';
}

// Display label for the left-rail badge / detail chip. `kind` stays the
// canonical value (drives KIND_STYLE, facet filters, counts); this only
// distinguishes who initiated a BASH event — a Claude Code Bash tool call
// (source='claude_tools') vs a user-typed shell command (source='commands').
function deriveKindLabel(kind, source) {
  if (kind === 'BASH') {
    if (source === 'commands') return 'BASH (user)';
    if (source === 'claude_tools') return 'BASH (claude)';
  }
  return kind;
}

function deriveFile(source, rl) {
  if (!rl) return undefined;
  if (source === 'audit') return rl.file || undefined;
  if (source === 'claude_tools') {
    return rl.input?.file_path || rl.input?.path || undefined;
  }
  return undefined;
}

// Data/results artifacts the researcher produces — distinct from source
// content. Extensions are matched case-insensitively. `json`/`jsonl` count as
// data here even though some are config: in these traces they are almost
// always eval results / metadata dumps.
const DATA_EXTS = new Set([
  'json', 'jsonl', 'csv', 'tsv', 'parquet', 'arrow', 'feather',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf',
  'npy', 'npz', 'pt', 'pth', 'ckpt', 'safetensors', 'bin',
  'pkl', 'pickle', 'h5', 'hdf5', 'log',
]);
// Source content the researcher authors.
const CODE_EXTS = new Set([
  'py', 'pyi', 'ipynb', 'js', 'jsx', 'ts', 'tsx', 'sh', 'bash', 'zsh',
  'md', 'rst', 'txt', 'toml', 'yaml', 'yml', 'cfg', 'ini', 'env',
  'html', 'css', 'scss', 'c', 'cc', 'cpp', 'h', 'hpp', 'rs', 'go',
  'java', 'rb', 'lock', 'sql', 'r',
]);

// Classify a path as authored source ('code') vs produced artifact ('data').
// Returns null when there is no usable extension to judge by.
function deriveFileClass(file) {
  if (!file) return null;
  const base = file.split('/').pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null; // no extension, or a dotfile like `.gitignore`
  const ext = base.slice(dot + 1).toLowerCase();
  if (DATA_EXTS.has(ext)) return 'data';
  if (CODE_EXTS.has(ext)) return 'code';
  return null;
}

function deriveTitle(kind, file, source, rl) {
  if (kind === 'BASH') {
    const cmd = rl?.input?.command || rl?.command || '';
    return cmd ? truncate(cmd.replace(/\s+/g, ' '), 90) : '(bash)';
  }
  if (kind === 'TOOL') {
    const tool = rl?.tool || 'tool';
    const ref = file || '';
    return `${tool}${ref ? ' · ' + ref : ''}`;
  }
  if (file) return file;
  return source;
}

function deriveSummary(kind, source, rl) {
  if (!rl) return '';
  if (source === 'audit') {
    const ev = rl.event || '';
    return ev ? `${rl.action || ''} (${ev})`.trim() : (rl.action || '');
  }
  if (source === 'commands') {
    const cwd = rl.cwd ? `cwd: ${shortenPath(rl.cwd)}` : '';
    const sess = rl.session ? `session ${rl.session}` : '';
    return [cwd, sess].filter(Boolean).join(' · ');
  }
  if (source === 'claude_tools') {
    const desc = rl.input?.description;
    if (desc) return truncate(desc, 120);
    const stdout = rl.response?.stdout;
    if (stdout) return truncate(firstLine(stdout), 120);
    return rl.tool || '';
  }
  return '';
}

function firstLine(s) {
  if (!s) return '';
  const i = s.indexOf('\n');
  return i < 0 ? s : s.slice(0, i);
}

function shortenPath(p) {
  if (!p) return '';
  if (p.length <= 48) return p;
  return '…' + p.slice(p.length - 47);
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function parseTs(ts) {
  if (!ts) return 0;
  // Audit timestamps are space-separated ("2026-04-07 10:29:59") and UTC, but
  // carry no timezone — coerce to ISO so Date.parse always succeeds, and pin to
  // UTC ('Z') when no offset is present. Otherwise Date.parse reads naive strings
  // in the viewer's local timezone, mis-sorting them against any timestamp that
  // does carry an explicit offset.
  let iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
  if (!/[zZ]$|[+-]\d\d:?\d\d$/.test(iso)) iso += 'Z';
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

const FLAG_LEVEL_HEAT = { high: 4, medium: 3, low: 2, mild: 2 };
const FLAG_LEVEL_RANK = { high: 3, medium: 2, low: 1, mild: 1 };

// Strip the AI-narrator suspicion layer off one chunk — the inverse of the
// suspicion derivation in buildDataset, for the no-suspicion case. Nulls the
// flag level + per-agent suspicions and recomputes the synthetic salience
// fields (suspicion weight, heat bucket, flagged) as if the narrator never ran.
// Deterministic pre-flags (`c.flag`, from the chunker — a heuristic note, not an
// AI verdict) and the auditor's own markups (userFlagged / visited / notes) are
// preserved: the gate is specifically the *AI* suspicion layer, nothing else.
function stripChunkSuspicion(c) {
  return {
    ...c,
    flagLevel: null,
    suspicions: [],
    suspicionAgg: null,
    suspicion: c.flag ? 0.5 : 0,        // mirrors buildDataset's preFlag-only weight
    h: c.flag ? 2 : 0,                  // mirrors FLAG_LEVEL_HEAT fallback for preFlag
    flagged: !!c.flag || !!c.userFlagged,
  };
}

// Neutralize the AI suspicion layer across a whole dataset when the auditor has
// AI flagging switched off (the default — anti-anchoring). Returns `data`
// untouched when `show` is true. When off it rebuilds chunks/byId/bySha from the
// stripped chunks (so even deep consumers that resolve sha→chunk see no
// suspicion), drops the suspicion-derived semantic areas entirely, and zeroes
// the coverage suspicion totals. Threads are intentionally left alone — a
// thread_agent line-of-work is a neutral grouping, not a suspicion verdict.
// Applied once at the data source (DataProvider) so there's a single gate and no
// per-screen leaks; the ungated data is still exposed as `rawData` for the
// export deliverable, which must stay complete regardless of this view toggle.
export function withSuspicionGate(data, show) {
  if (show || !data || !data.chunks) return data;
  const chunks = data.chunks.map(stripChunkSuspicion);
  const byId = Object.fromEntries(chunks.map((c) => [c.id, c]));
  const bySha = {};
  for (const c of chunks) { if (c.sha && !(c.sha in bySha)) bySha[c.sha] = c; }
  return {
    ...data,
    chunks,
    byId,
    bySha,
    semanticAreas: [],
    coverage: { ...data.coverage, susSeen: 0, susTotal: 0 },
  };
}

// Resolve a possibly-abbreviated commit SHA to its full 40-char form. The
// commit builder normally emits full SHAs, but some artifacts (thread
// annotations / semantic_threads) abbreviate to 7 chars; those must still
// link back to commits. Returns the full SHA on an exact or unique-prefix
// match, else null (ambiguous prefix or unknown). Results are memoised, and
// the linear prefix scan only runs for non-exact (i.e. abbreviated) lookups.
function makeShaResolver(fullShas) {
  const full = new Set();
  for (const s of fullShas) { if (s) full.add(s); }
  const sorted = [...full].sort();
  const cache = new Map();
  return (sha) => {
    if (!sha) return null;
    if (full.has(sha)) return sha;
    if (cache.has(sha)) return cache.get(sha);
    let hit = null;
    for (const f of sorted) {
      if (f.startsWith(sha)) { if (hit) { hit = null; break; } hit = f; }  // 2+ ⇒ ambiguous
    }
    cache.set(sha, hit);
    return hit;
  };
}

// Derive the "semantic areas" view directly from the loaded suspicions —
// no precomputed sidecar (which is what fell out of sync with re-emitted SHAs).
// An area is one non-dropped suspicion that *links multiple commits*: its anchor
// inner_commit_sha plus the evidence_commits it cites. A suspicion that resolves
// to a single commit is just a dossier flag, not an area. `commit_shas` keeps
// only SHAs that resolve to a real commit in this trace (so the strip/diff
// progression always works) and is ordered chronologically by chunk index.
//
// `clusters` is an optional second source (semantic_clusters.jsonl) — explicit
// idea-clusters from a future producer; each is mapped to the same shape with
// source:'cluster'. The two are merged so the screen renders them uniformly.
function deriveSemanticAreas(suspicions, bySha, clusters, resolveSha) {
  const ord = (sha) => (bySha[sha] ? bySha[sha].index : Number.MAX_SAFE_INTEGER);
  const resolvedSorted = (shas) => {
    const seen = new Set();
    const out = [];
    for (const sha of shas) {
      const full = resolveSha(sha);
      if (full && bySha[full] && !seen.has(full)) { seen.add(full); out.push(full); }
    }
    return out.sort((a, b) => ord(a) - ord(b));
  };

  const areas = [];
  for (const s of suspicions || []) {
    if (s?.dropped_by_opus) continue;
    const anchor = resolveSha(s.inner_commit_sha) || s.inner_commit_sha;
    const commit_shas = resolvedSorted([s.inner_commit_sha, ...(s.evidence_commits || [])]);
    if (commit_shas.length < 2) continue;  // needs multiple linked commits
    const category = s.category || 'other';
    areas.push({
      area_id: s.suspicion_id || `${s.agent_id || 'agent'}:${(anchor || '').slice(0, 8)}`,
      source: 'suspicion',
      title: `${category.replace(/_/g, ' ')} (${s.flag_level})`,
      category,
      flag_level: s.flag_level,
      intent_hypothesis: s.intent_hypothesis || 'unclear',
      agent_id: s.agent_id || '',
      anchor_sha: anchor,
      commit_shas,
      commentary: s.commit_commentary || '',
      reasoning: s.suspicion_reasoning || '',
      suspicion_id: s.suspicion_id || null,
      reviewed_by_opus: !!s.reviewed_by_opus,
      opus_addendum: s.opus_addendum || null,
    });
  }

  // Optional explicit clusters (future producer). Tolerant of field naming.
  for (const c of clusters || []) {
    const commit_shas = resolvedSorted(c.commit_shas || c.commits || []);
    if (commit_shas.length < 2) continue;
    areas.push({
      area_id: c.area_id || c.cluster_id || `cluster:${commit_shas[0].slice(0, 8)}`,
      source: 'cluster',
      title: c.title || 'semantic cluster',
      category: c.category || 'other',
      flag_level: c.flag_level || null,
      intent_hypothesis: c.intent_hypothesis || 'unclear',
      agent_id: c.agent_id || '',
      anchor_sha: resolveSha(c.anchor_sha) || commit_shas[0],
      commit_shas,
      commentary: c.commentary || c.description || '',
      reasoning: c.reasoning || '',
      suspicion_id: null,
      reviewed_by_opus: false,
      opus_addendum: null,
    });
  }

  // Chronological by anchor so the list reads in trace order.
  areas.sort((a, b) => ord(a.anchor_sha) - ord(b.anchor_sha));
  return areas;
}

// Normalise the thread_agent's thread_annotations.jsonl into screen-ready
// threads: each carries the lead's commits (ordered chronologically by chunk
// index, keeping only those resolvable in this trace), the subagent's
// direction + reasoning, and a per-commit beat-note map. Mirrors
// deriveSemanticAreas, but a thread is an LLM-identified line of work (commits
// grouped by meaning, often non-adjacent) rather than one suspicion's citations.
function deriveThreads(threadAnnotations, bySha, resolveSha) {
  const ord = (sha) => (bySha[sha] ? bySha[sha].index : Number.MAX_SAFE_INTEGER);
  const out = [];
  for (const a of threadAnnotations || []) {
    if (!a) continue;
    const raw = Array.isArray(a.commits) ? a.commits : [];
    // beats are keyed by the *resolved* full SHA so CommitStrip — which renders
    // commit_shas (also full) — can look up each beat note.
    const beats = {};
    for (const b of (a.commit_beats || [])) { const full = resolveSha(b?.sha); if (full) beats[full] = b.note || ''; }
    const seen = new Set();
    const commit_shas = [];
    for (const sha of raw) {
      const full = resolveSha(sha);
      if (full && !seen.has(full)) { seen.add(full); commit_shas.push(full); }
    }
    commit_shas.sort((x, y) => ord(x) - ord(y));
    out.push({
      thread_id: a.thread_id,
      label: a.label || '(thread)',
      direction: a.direction || '',
      reasoning: a.reasoning || '',
      theme: a.theme || 'other',
      commit_shas,        // ordered, resolvable
      raw_commits: raw,   // everything the subagent listed
      beats,              // sha → per-commit note
    });
  }
  return out;
}

function buildDataset({ name, events, bashIndex, flags, suspicions, aggSuspicions, overallRating, sidecar, clusters, annotations, threadAnnotations }) {
  // Index the deterministic commit classification by sha. Absent for older
  // traces — when missing, chunks carry `mutating: undefined` and the inbox
  // falls back to rendering every row at full prominence.
  const sideBySha = {};
  for (const s of sidecar || []) {
    if (s?.sha) sideBySha[s.sha] = s;
  }
  // Commits are the full SHAs on the event stream; some artifacts (threads)
  // abbreviate, so resolve every artifact SHA through this before keying/joining.
  const resolveSha = makeShaResolver((events || []).map((e) => e.inner_commit_sha));
  // Index flags by primary_sha so we can left-join onto every event.
  const flagBySha = {};
  for (const f of flags) {
    if (f?.primary_sha) {
      (flagBySha[f.primary_sha] = flagBySha[f.primary_sha] || []).push(f);
    }
  }
  // Index suspicions per-sha (multiple agents may flag the same commit).
  const susBySha = {};
  for (const s of suspicions) {
    const sha = s?.inner_commit_sha;
    if (sha) (susBySha[sha] = susBySha[sha] || []).push(s);
  }
  const aggBySha = {};
  for (const a of aggSuspicions) {
    if (a?.inner_commit_sha) aggBySha[a.inner_commit_sha] = a;
  }
  // Index bash context by sha.
  const bashBySha = {};
  for (const b of bashIndex) {
    if (b?.inner_commit_sha) bashBySha[b.inner_commit_sha] = b;
  }
  // Index descriptive annotations (annotation_agent). Commit-targeted ones join
  // onto a commit by sha; group-targeted ones join onto a sidecar group by
  // group_id so a group's dossier can pull in its members' descriptions.
  const annoBySha = {};
  const annoByGroup = {};
  for (const a of annotations || []) {
    if (a?.target_kind === 'group' && a.group_id) {
      (annoByGroup[a.group_id] = annoByGroup[a.group_id] || []).push(a);
    } else if (a?.inner_commit_sha) {
      (annoBySha[a.inner_commit_sha] = annoBySha[a.inner_commit_sha] || []).push(a);
    }
  }
  // Index semantic threads by member sha so a commit's dossier can denote which
  // thread(s) it belongs to (with this commit's beat note, if any).
  const threadBySha = {};
  for (const a of threadAnnotations || []) {
    if (!a) continue;
    const beats = {};
    for (const b of (a.commit_beats || [])) { const full = resolveSha(b?.sha); if (full) beats[full] = b.note || ''; }
    for (const sha of (a.commits || [])) {
      const full = resolveSha(sha);
      if (!full) continue;
      (threadBySha[full] = threadBySha[full] || []).push({
        thread_id: a.thread_id,
        label: a.label || '(thread)',
        theme: a.theme || 'other',
        note: beats[full] || '',
      });
    }
  }

  // Build a chunk-shaped record per event.
  const chunks = events.map((e) => {
    const rl = safeParseRawLine(e.raw_line);
    const source = e.source;
    const kind = deriveKind(source, rl);
    const kindLabel = deriveKindLabel(kind, source);
    const file = deriveFile(source, rl);
    const fileClass = deriveFileClass(file);  // 'code' | 'data' | null
    const title = deriveTitle(kind, file, source, rl);
    const summary = deriveSummary(kind, source, rl);
    const t = parseTs(e.ts);
    const sha = e.inner_commit_sha || '';
    const flagList = flagBySha[sha] || [];
    const preFlag = flagList[0] || null;
    const bashContext = bashBySha[sha] || null;
    const susList = susBySha[sha] || [];
    const susAgg = aggBySha[sha] || null;
    const side = sideBySha[sha] || null;
    const annoList = annoBySha[sha] || [];
    // Inbox-row conveniences off the descriptive annotations: the <=10-word
    // headline (short_title) and the full "what is being done" text. First
    // non-empty wins when more than one agent annotated the same commit.
    const shortTitle = annoList.find((a) => a && a.short_title)?.short_title || '';
    const annotationText = annoList.find((a) => a && a.annotation)?.annotation || '';
    // Highest individual flag level for ranking in the inbox; aggregate
    // record (if present) is the authoritative max.
    const flagLevel = susAgg?.flag_level_max || susList.reduce((best, s) => {
      return (FLAG_LEVEL_RANK[s.flag_level] || 0) > (FLAG_LEVEL_RANK[best] || 0) ? s.flag_level : best;
    }, null);
    const heatBucket = FLAG_LEVEL_HEAT[flagLevel] || (preFlag ? 2 : 0);
    return {
      id: e.event_id,
      sha,
      t,
      tEnd: t,
      source,
      kind,
      kindLabel,                // 'BASH (user)' | 'BASH (claude)' | == kind otherwise
      file,
      fileClass,                // 'code' (authored source) | 'data' (artifact) | null
      title,
      summary,
      rawLine: rl,
      flag: preFlag,            // first matching flag, if any
      flags: flagList,          // all matching flags
      bashContext,              // { session, cwd, command, pane_log_lines, … } | null
      suspicions: susList,      // detailed per-agent suspicion entries (0+)
      suspicionAgg: susAgg,     // aggregated row (0|1)
      annotations: annoList,              // descriptive "what is being done" notes (0+)
      shortTitle,                         // annotation agent's <=10-word headline ('' if none)
      annotationText,                     // representative full annotation text ('' if none)
      threads: threadBySha[sha] || [],     // semantic threads this commit belongs to (0+)
      flagLevel,                // 'high' | 'medium' | 'low' | 'mild' | null
      // Deterministic commit classification (undefined when no sidecar):
      mutating: side ? side.mutating : undefined,  // false ⇒ non-invasive / read-only
      groupId: side?.group_id ?? null,             // multi-commit semantic group
      groupSize: side?.group_size ?? 1,
      groupIndex: side?.group_index ?? 0,
      groupKind: side?.group_kind ?? null,         // 'edit_sequence' | 'dir_deletion'
      groupRoot: side?.group_root ?? null,         // shared path / deleted directory
      // Synthetic fields kept for shared components:
      suspicion: flagLevel ? 1 : (preFlag ? 0.5 : 0),
      h: heatBucket,
      flagged: !!preFlag || !!flagLevel,
      visited: false,
      userNotes: [],
    };
  });

  // Sort chronologically; assign index after sort so it matches the order
  // every consumer sees.
  chunks.sort((a, b) => a.t - b.t);
  chunks.forEach((c, i) => { c.index = i; });
  const byId = Object.fromEntries(chunks.map((c) => [c.id, c]));
  // sha → chunk so the semantic-area view can resolve a list of inner SHAs back
  // to commits (each commit-builder commit is one event, so this is 1:1; first
  // chunk wins on the rare collision).
  const bySha = {};
  for (const c of chunks) {
    if (c.sha && !(c.sha in bySha)) bySha[c.sha] = c;
  }
  // Semantic areas: derived now, not loaded — see deriveSemanticAreas.
  const semanticAreas = deriveSemanticAreas(suspicions, bySha, clusters, resolveSha);
  // Semantic threads: the thread_agent's lines of work, ordered for the screen.
  const threads = deriveThreads(threadAnnotations, bySha, resolveSha);

  const total = chunks.length;
  const susTotal = chunks.reduce((s, c) => s + c.suspicion, 0);
  const meta = {
    experiment: name || null,
    tStart: chunks[0]?.t,
    tEnd: chunks[chunks.length - 1]?.t,
    eventCount: total,
    flagCount: chunks.filter((c) => c.flagged).length,
    suspicionCount: chunks.filter((c) => c.flagLevel).length,
    overallRating,
  };

  return {
    meta,
    chunks,
    relations: [],
    byId,
    bySha,
    flags,
    overallRating,
    semanticAreas: semanticAreas || [],
    threads: threads || [],           // thread_agent lines of work (screen + commit boxes)
    annotationsByGroup: annoByGroup,  // group_id → group-level annotations (0+)
    coverage: { visited: 0, total, susSeen: 0, susTotal },
  };
}

async function loadInput(name) {
  const fetchJsonl = async (candidates) => parseJsonl(await (await fetchFirstOk(name, candidates)).text());
  const fetchJson = async (candidates) => (await fetchFirstOk(name, candidates)).json();
  const [events, bashIndex, flags, suspicions, aggSuspicions, overallRating, sidecar, clusters, annotations, threadAnnotations] = await Promise.all([
    fetchJsonl(cbCandidates('event_commit_map.jsonl')),
    fetchJsonl(cbCandidates('bash_index.jsonl')).catch(() => []),
    fetchJsonl(cbCandidates('flags.jsonl')).catch(() => []),
    fetchJsonl(susCandidates('suspicions.jsonl')).catch(() => []),
    fetchJsonl(susCandidates('aggregated_suspicions.jsonl')).catch(() => []),
    fetchJson(susCandidates('overall_rating.json')).catch(() => null),
    fetchJsonl(cbCandidates('commit_sidecar.jsonl')).catch(() => []),
    // Semantic areas are now derived in-UI from suspicions (below), so there's
    // no semantic_areas.jsonl to load. semantic_clusters.jsonl is an optional
    // *second* source: explicit idea-clusters from a future producer, merged in
    // alongside the suspicion-derived areas. Absent for now → [].
    fetchJsonl(susCandidates('semantic_clusters.jsonl')).catch(() => []),
    fetchJsonl(susCandidates('annotations.jsonl')).catch(() => []),
    fetchJsonl(susCandidates('thread_annotations.jsonl')).catch(() => []),
  ]);
  return buildDataset({ name, events, bashIndex, flags, suspicions, aggSuspicions, overallRating, sidecar, clusters, annotations, threadAnnotations });
}

export const DataContext = React.createContext(null);

export function useData() {
  const ctx = React.useContext(DataContext);
  if (!ctx) throw new Error('useData must be used inside <DataProvider>');
  return ctx;
}

export function DataProvider({ children }) {
  const [state, setState] = React.useState({ status: 'loading', error: null, data: null });
  const [inputs, setInputs] = React.useState([]);
  const [selectedInput, setSelectedInput] = React.useState(null);
  const [currentId, setCurrentId] = React.useState(null);
  const [screen, setScreen] = React.useState('dossier');
  // Entry selection for the areas screen, carried as a token ("thread:<id>" /
  // "area:<id>") so a commit's thread link can deep-link into that thread. Part
  // of the nav tuple alongside screen/id; the areas screen applies it once.
  const [areaFocus, setAreaFocus] = React.useState(null);
  const [visitedOverlay, setVisitedOverlay] = React.useState({});  // id → true
  const [flaggedOverlay, setFlaggedOverlay] = React.useState({});  // id → true (user-added flag)
  const [userNotesOverlay, setUserNotesOverlay] = React.useState({}); // id → UserNote[]
  const [dismissedOverlay, setDismissedOverlay] = React.useState({}); // key → true (agent suspicion dismissed)
  const [userGroupsOverlay, setUserGroupsOverlay] = React.useState({}); // groupId → { id, name, color, createdAt }
  const [groupTagsOverlay, setGroupTagsOverlay] = React.useState({});   // targetKey → [groupId]
  const userNoteSeq = React.useRef(0);
  const userGroupSeq = React.useRef(0);
  // The AI-suspicion gate (default off). Read here — DataProvider renders inside
  // SettingsProvider (see App.jsx) — so the suspicion layer can be neutralized
  // once, at the source, for every consumer. See withSuspicionGate.
  const { showAiSuspicion } = useSettings();

  // Manifest discovery.
  React.useEffect(() => {
    let cancelled = false;
    fetch(MANIFEST_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`manifest ${r.status}`))))
      .then((json) => {
        if (cancelled) return;
        const list = Array.isArray(json?.inputs) ? json.inputs : [];
        const normalised = list.map((it) => (typeof it === 'string'
          ? { name: it, label: it }
          : { name: it.name, label: it.label || it.name }));
        setInputs(normalised);
        if (normalised.length === 0) return;
        // Restore priority, narrowest match first:
        //   1. history.state — survives a reload / back-forward and carries the
        //      full position (trace + screen + commit), so prefer it.
        //   2. the persisted last-input — survives a true reopen (fresh tab /
        //      browser restart) where history.state is gone; trace only, so it
        //      lands at the trace's default position.
        //   3. otherwise default to the last input. The manifest is sorted
        //      alphabetically by label, so this is the last alphabetically —
        //      the most recent trace, with the date-prefixed dir names.
        const saved = window.history.state;
        const remembered = loadLastInput();
        if (saved?.input && normalised.some((n) => n.name === saved.input)) {
          pendingNav.current = { screen: saved.screen ?? 'dossier', id: saved.id ?? null, focus: saved.focus ?? null };
          setSelectedInput(saved.input);
        } else if (remembered && normalised.some((n) => n.name === remembered)) {
          setSelectedInput(remembered);
        } else {
          setSelectedInput(normalised[normalised.length - 1].name);
        }
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', error: `manifest: ${err.message}`, data: null });
      });
    return () => { cancelled = true; };
  }, []);

  // Per-input load — reset user overlays since they belonged to the previous
  // input, and restore the position carried in pendingNav (a back/forward or
  // hard-reload restore into this trace); otherwise start the trace fresh.
  React.useEffect(() => {
    if (!selectedInput) return;
    let cancelled = false;
    // Every selection — initial default, restore, or a user swap — funnels
    // through here, so this is the one place to remember the active trace for a
    // future reopen.
    saveLastInput(selectedInput);
    const target = pendingNav.current || { screen: 'dossier', id: null, focus: null };
    pendingNav.current = null;
    setState({ status: 'loading', error: null, data: null });
    setCurrentId(target.id);
    setScreen(target.screen);
    setAreaFocus(target.focus ?? null);
    // Record the live tuple on the current history entry so a reload (state
    // persists across reloads) or a back-step lands exactly here.
    window.history.replaceState({ input: selectedInput, screen: target.screen, id: target.id, focus: target.focus ?? null }, '');
    // Markups are per-trace and persisted — load this trace's, then fold in
    // the just-visited commit from the restored position.
    const stored = loadStoredOverlays(selectedInput);
    const visited = { ...stored.visited };
    if (target.id != null) visited[target.id] = true;
    visitedRef.current = visited;
    flaggedRef.current = stored.flagged;
    notesRef.current = stored.notes;
    dismissedRef.current = stored.dismissed;
    groupsRef.current = stored.groups;
    tagsRef.current = stored.tags;
    setVisitedOverlay(visited);
    setFlaggedOverlay(stored.flagged);
    setUserNotesOverlay(stored.notes);
    setDismissedOverlay(stored.dismissed);
    setUserGroupsOverlay(stored.groups);
    setGroupTagsOverlay(stored.tags);
    saveStoredOverlays(selectedInput, visited, stored.flagged, stored.notes, stored.dismissed, stored.groups, stored.tags);
    loadInput(selectedInput)
      .then((data) => {
        if (cancelled) return;
        data.inputName = selectedInput;
        setState({ status: 'ready', error: null, data });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', error: err.message, data: null });
      });
    return () => { cancelled = true; clearTimeout(auditSyncTimer.current); };
  }, [selectedInput]);

  // Mirror the live overlays so mutators can read-current / compute-next /
  // set-and-persist in one synchronous shot. A persistence *effect* would
  // misfire during a trace swap (selectedInput already flipped to B while the
  // overlay state is still A's), writing A's markups under B's key — so we
  // write through here instead, always against the trace the overlays belong
  // to (inputRef), never the trace being navigated to.
  const visitedRef = React.useRef(visitedOverlay);
  visitedRef.current = visitedOverlay;
  const flaggedRef = React.useRef(flaggedOverlay);
  flaggedRef.current = flaggedOverlay;
  const notesRef = React.useRef(userNotesOverlay);
  notesRef.current = userNotesOverlay;
  const dismissedRef = React.useRef(dismissedOverlay);
  dismissedRef.current = dismissedOverlay;
  const groupsRef = React.useRef(userGroupsOverlay);
  groupsRef.current = userGroupsOverlay;
  const tagsRef = React.useRef(groupTagsOverlay);
  tagsRef.current = groupTagsOverlay;

  // Mirror the loaded dataset so the debounced, ref-driven disk-sync can read the
  // current data without a stale closure.
  const stateRef = React.useRef(state);
  stateRef.current = state;

  // Dev-only mirror of the auditor's overlays to disk (the trace's own
  // <traceDir>/audit/), so a local coding agent (Claude Code, Codex) can read
  // what was flagged / noted.
  // localStorage stays the source of truth; this is an eventually-consistent,
  // debounced mirror written through the Vite dev-server's POST /api/audit. A
  // static build has no endpoint, so import.meta.env.DEV gates it (no 404 noise);
  // any network error is swallowed (localStorage still holds the state).
  const auditSyncTimer = React.useRef(null);
  const syncAuditToDisk = React.useCallback((name) => {
    if (!import.meta.env.DEV || !name) return;
    const st = stateRef.current;
    if (!st || st.status !== 'ready' || !st.data) return;
    let files;
    try {
      const model = buildAuditModel({
        trace: name,
        data: st.data,
        overlays: {
          flagged: flaggedRef.current,
          notes: notesRef.current,
          dismissed: dismissedRef.current,
          groups: groupsRef.current,
          tags: tagsRef.current,
          visited: visitedRef.current,
        },
      });
      files = serializeAuditFiles(model);
    } catch { return; }  // serialization must never break the UI
    fetch(AUDIT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, files }),
    }).catch(() => { /* no dev server / offline — localStorage still holds it */ });
  }, []);
  // Coalesce a burst of toggles / edits into one write set. Capture the trace at
  // schedule time and re-check at fire time, so a trace swap mid-debounce can't
  // write trace A's overlays under trace B's directory.
  const scheduleAuditSync = React.useCallback(() => {
    const name = inputRef.current;
    clearTimeout(auditSyncTimer.current);
    auditSyncTimer.current = setTimeout(() => {
      if (inputRef.current === name) syncAuditToDisk(name);
    }, 1000);
  }, [syncAuditToDisk]);

  const persistOverlays = React.useCallback(() => {
    saveStoredOverlays(inputRef.current, visitedRef.current, flaggedRef.current, notesRef.current, dismissedRef.current, groupsRef.current, tagsRef.current);
    scheduleAuditSync();
  }, [scheduleAuditSync]);

  const visitChunk = React.useCallback((id) => {
    if (id == null || visitedRef.current[id]) return;
    const next = { ...visitedRef.current, [id]: true };
    visitedRef.current = next;
    setVisitedOverlay(next);
    persistOverlays();
  }, [persistOverlays]);

  // ── Navigation history ─────────────────────────────────────────────────
  // (input, screen, currentId) is one navigation tuple — the trace is part of
  // the address, so swapping traces is itself a history step. Every
  // user-initiated nav pushes a single browser-history entry, so the
  // back/forward mouse buttons and browser chrome walk the tuple. popstate
  // restores a tuple WITHOUT re-pushing. Because the browser persists session
  // history + state objects across a hard reload, recording the tuple via
  // replaceState is also what makes reload restore your place. Refs mirror the
  // live tuple so a push records the current entry's neighbour without
  // stale-closure drift. pendingNav holds the (screen,id) to apply once an
  // async trace-load finishes — a cross-trace restore can't set the commit
  // until that trace's data exists.
  const inputRef = React.useRef(selectedInput);
  inputRef.current = selectedInput;
  const screenRef = React.useRef(screen);
  screenRef.current = screen;
  const currentIdRef = React.useRef(currentId);
  currentIdRef.current = currentId;
  const focusRef = React.useRef(areaFocus);
  focusRef.current = areaFocus;
  const pendingNav = React.useRef(null);

  // Apply a tuple to live state. Shared by the history-pushing actions and by
  // popstate — the latter must not push, so pushing lives in pushNav only. A
  // cross-trace tuple defers screen/id to the load effect via pendingNav.
  const applyNav = React.useCallback(({ input, screen: s, id, focus }) => {
    if (input !== undefined && input !== inputRef.current) {
      pendingNav.current = { screen: s ?? 'dossier', id: id ?? null, focus: focus ?? null };
      setSelectedInput(input);
      return;
    }
    if (s !== undefined) setScreen(s);
    if (id !== undefined) {
      setCurrentId(id);
      if (id != null) visitChunk(id);
    }
    if (focus !== undefined) setAreaFocus(focus);
  }, [visitChunk]);

  // Push one entry for the next tuple, collapsing no-op repeats (e.g.
  // re-clicking the already-selected commit on the same screen/trace).
  const pushNav = React.useCallback((input, s, id, focus) => {
    if (input === inputRef.current && s === screenRef.current
      && id === currentIdRef.current && focus === focusRef.current) return;
    window.history.pushState({ input, screen: s, id, focus }, '');
  }, []);

  // Record the in-screen selection (a rail item on the areas screen, the group
  // dossier on the inbox, the open doc on results) onto the CURRENT history
  // entry — a replaceState, NOT a new back-step, so browsing the rail isn't a
  // history step, but back/forward and reload restore which item was open. Each
  // screen hydrates its local selection FROM areaFocus on (re)mount, and was the
  // only writer that never wrote back — so leaving and returning reset it to the
  // default. setAreaFocus keeps live consumers in sync; the refs carry the rest
  // of the current tuple. No-op when the focus already matches.
  const recordFocus = React.useCallback((focus) => {
    const next = focus ?? null;
    if (next === focusRef.current) return;
    setAreaFocus(next);
    window.history.replaceState(
      { input: inputRef.current, screen: screenRef.current, id: currentIdRef.current, focus: next },
      '',
    );
  }, []);

  // The areas-screen focus is a one-shot set only by openThread; every other
  // nav clears it (passes null), so e.g. clicking the "areas" tab later lands on
  // the default selection rather than a stale deep-linked thread. Back/forward
  // still restore whatever focus the visited history entry recorded.
  const navigate = React.useCallback((id) => {
    pushNav(inputRef.current, screenRef.current, id, null);
    applyNav({ id, focus: null });
  }, [pushNav, applyNav]);

  const goScreen = React.useCallback((s) => {
    pushNav(inputRef.current, s, currentIdRef.current, null);
    applyNav({ screen: s, focus: null });
  }, [pushNav, applyNav]);

  // Coalesced jump from the overview: switch to the dossier AND select a
  // commit as a SINGLE history entry, so one "back" returns to the overview.
  const openCommit = React.useCallback((id) => {
    pushNav(inputRef.current, 'dossier', id, null);
    applyNav({ screen: 'dossier', id, focus: null });
  }, [pushNav, applyNav]);

  // Jump from a commit's thread link straight to that thread on the areas
  // screen — one history entry, so a single "back" returns to the commit.
  const openThread = React.useCallback((threadId) => {
    const focus = `thread:${threadId}`;
    pushNav(inputRef.current, 'areas', currentIdRef.current, focus);
    applyNav({ screen: 'areas', focus });
  }, [pushNav, applyNav]);

  // Mirror of openThread for a flagged area — lets the overview's area-note
  // rows deep-link straight to the corresponding row on the areas screen.
  const openArea = React.useCallback((areaId) => {
    const focus = `area:${areaId}`;
    pushNav(inputRef.current, 'areas', currentIdRef.current, focus);
    applyNav({ screen: 'areas', focus });
  }, [pushNav, applyNav]);

  // Mirror of openArea for a user group — the overview's user-group rows
  // deep-link to that group's entry in the semantic-areas left rail (it leads
  // the rail, above the AI-derived flagged areas).
  const openUserGroup = React.useCallback((groupId) => {
    const focus = `usergroup:${groupId}`;
    pushNav(inputRef.current, 'areas', currentIdRef.current, focus);
    applyNav({ screen: 'areas', focus });
  }, [pushNav, applyNav]);

  // Mirror of openCommit for a flagged commit-group: jump to the dossier with
  // the group selected (the cumulative-diff view), not one of its members.
  // `anchorId` is one member commit id used to position the inbox scroll — the
  // dossier reads the `group:<id>` focus separately to switch into group mode.
  const openGroup = React.useCallback((groupId, anchorId) => {
    const focus = `group:${groupId}`;
    pushNav(inputRef.current, 'dossier', anchorId, focus);
    applyNav({ screen: 'dossier', id: anchorId, focus });
  }, [pushNav, applyNav]);

  // Mirror of openArea/openThread for a result document: jump to the results
  // screen with that doc focused (a `doc:<id>` focus token the results screen
  // reads), so the overview's doc markups deep-link back to the file they
  // annotate. One history entry — a single "back" returns to the overview.
  const openDoc = React.useCallback((docId) => {
    const focus = `doc:${docId}`;
    pushNav(inputRef.current, 'results', currentIdRef.current, focus);
    applyNav({ screen: 'results', focus });
  }, [pushNav, applyNav]);

  // Swapping traces is a history step: push a fresh-start entry for the new
  // trace on top of the current one, so back returns to this trace with the
  // commit/screen we left it on (preserved in the entry below).
  const selectInput = React.useCallback((name) => {
    if (!name || name === inputRef.current) return;
    pushNav(name, 'dossier', null, null);
    setSelectedInput(name);
  }, [pushNav]);

  // Browser back/forward (incl. mouse side-buttons) → restore tuple, no push.
  // No mount-time replaceState here: that would clobber the entry the browser
  // restored on reload. The load effect owns recording the live tuple.
  React.useEffect(() => {
    const onPop = (e) => {
      const st = e.state;
      if (st) applyNav({ input: st.input, screen: st.screen ?? 'dossier', id: st.id ?? null, focus: st.focus ?? null });
      else applyNav({ screen: 'dossier', id: null, focus: null });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [applyNav]);

  // Keyboard transport: ← / ↑ step to the previous commit chronologically, → / ↓
  // to the next. Chunks are stored in chronological order, so this walks that
  // order regardless of the active screen's filters. Skipped while focus is in a
  // text field (so notes keep their own cursor) or a modifier is held (don't
  // shadow browser/OS shortcuts); on the spine, arrows otherwise just scroll, so
  // we preventDefault once we've claimed the key.
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target;
      const tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      let dir = 0;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') dir = -1;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') dir = 1;
      else return;
      const chunks = state.data?.chunks;
      if (!chunks || chunks.length === 0) return;
      e.preventDefault();
      const idx = currentIdRef.current ? chunks.findIndex((c) => c.id === currentIdRef.current) : -1;
      const base = idx < 0 ? (dir > 0 ? -1 : 0) : idx;
      const nextIdx = Math.max(0, Math.min(chunks.length - 1, base + dir));
      if (nextIdx !== idx) navigate(chunks[nextIdx].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.data, navigate]);

  const toggleFlag = React.useCallback((id) => {
    const next = { ...flaggedRef.current };
    if (next[id]) delete next[id]; else next[id] = true;
    flaggedRef.current = next;
    setFlaggedOverlay(next);
    persistOverlays();
  }, [persistOverlays]);

  // Dismiss an agent-surfaced suspicion: the auditor's "I looked, this is fine"
  // verdict. Keyed by chunk id (overview / dossier suspicion commits) or the
  // namespaced area:/thread: id (semantic-areas flagged areas). Dismissal doesn't
  // delete anything — the suspicion still renders, just demoted (lower-saturation
  // warning colour) and reordered (own section / pushed to the back). The same
  // overlay is read on every screen, so dismissing a commit from the dossier
  // also dismisses it on overview, and vice versa.
  const toggleDismiss = React.useCallback((key) => {
    const next = { ...dismissedRef.current };
    if (next[key]) delete next[key]; else next[key] = true;
    dismissedRef.current = next;
    setDismissedOverlay(next);
    persistOverlays();
  }, [persistOverlays]);

  // Set many dismiss keys at once to the same target state — used when a
  // semantic-area dismiss should cascade to every linked commit's chunk id so
  // they all flip together (no batched-render race, no surprise half-dismissed
  // state). Pass `dismissed=false` to restore the same batch.
  const setDismissed = React.useCallback((keys, dismissed) => {
    if (!keys || keys.length === 0) return;
    const next = { ...dismissedRef.current };
    for (const k of keys) {
      if (!k) continue;
      if (dismissed) next[k] = true; else delete next[k];
    }
    dismissedRef.current = next;
    setDismissedOverlay(next);
    persistOverlays();
  }, [persistOverlays]);

  const addUserNote = React.useCallback((chunkId, text) => {
    const t = (text || '').trim();
    if (!t) return;
    const now = Date.now();
    const id = `un_${now}_${++userNoteSeq.current}`;
    const cur = notesRef.current;
    const next = { ...cur, [chunkId]: [...(cur[chunkId] || []), { id, text: t, createdAt: now, editedAt: now }] };
    notesRef.current = next;
    setUserNotesOverlay(next);
    persistOverlays();
  }, [persistOverlays]);

  const updateUserNote = React.useCallback((chunkId, noteId, text) => {
    const t = (text || '').trim();
    const cur = notesRef.current;
    const list = (cur[chunkId] || []).map((n) => (n.id === noteId ? { ...n, text: t, editedAt: Date.now() } : n));
    const next = { ...cur, [chunkId]: list };
    notesRef.current = next;
    setUserNotesOverlay(next);
    persistOverlays();
  }, [persistOverlays]);

  const deleteUserNote = React.useCallback((chunkId, noteId) => {
    const cur = notesRef.current;
    const list = (cur[chunkId] || []).filter((n) => n.id !== noteId);
    const next = { ...cur };
    if (list.length) next[chunkId] = list; else delete next[chunkId];
    notesRef.current = next;
    setUserNotesOverlay(next);
    persistOverlays();
  }, [persistOverlays]);

  // ── User groups (auditor-created tags) ─────────────────────────────────────
  // A user group is the auditor's own grouping: flag an item, then tag it into a
  // named group ("add to group"). The group is a first-class record in the
  // registry so it persists with its own annotations even when membership
  // changes. `tagTarget`/`untagTarget` edit the membership map keyed by the same
  // target keys flags use; the group's own notes/flag live under `usergroup:<id>`
  // (and so are cleared with the rest of the notes/flagged overlays on reset).
  // `color` is supplied by the caller (the tag editor cycles a palette) so the
  // store stays palette-agnostic. createUserGroup returns the new id so the
  // caller can immediately tag the target it was created from.
  const createUserGroup = React.useCallback((name, color) => {
    const nm = (name || '').trim();
    if (!nm) return null;
    const now = Date.now();
    const id = `ug_${now}_${++userGroupSeq.current}`;
    const next = { ...groupsRef.current, [id]: { id, name: nm, color: color || null, createdAt: now } };
    groupsRef.current = next;
    setUserGroupsOverlay(next);
    persistOverlays();
    return id;
  }, [persistOverlays]);

  const renameUserGroup = React.useCallback((id, name) => {
    const nm = (name || '').trim();
    const cur = groupsRef.current[id];
    if (!cur || !nm) return;
    const next = { ...groupsRef.current, [id]: { ...cur, name: nm } };
    groupsRef.current = next;
    setUserGroupsOverlay(next);
    persistOverlays();
  }, [persistOverlays]);

  // Delete a group: drop the registry entry, strip it from every membership, and
  // clear its own flag + annotations (the `usergroup:<id>` overlay keys).
  const deleteUserGroup = React.useCallback((id) => {
    const nextGroups = { ...groupsRef.current };
    delete nextGroups[id];
    groupsRef.current = nextGroups;
    setUserGroupsOverlay(nextGroups);
    const nextTags = {};
    for (const [k, ids] of Object.entries(tagsRef.current)) {
      const kept = (ids || []).filter((g) => g !== id);
      if (kept.length) nextTags[k] = kept;
    }
    tagsRef.current = nextTags;
    setGroupTagsOverlay(nextTags);
    const ukey = `usergroup:${id}`;
    if (flaggedRef.current[ukey]) {
      const nf = { ...flaggedRef.current }; delete nf[ukey];
      flaggedRef.current = nf; setFlaggedOverlay(nf);
    }
    if (notesRef.current[ukey]) {
      const nn = { ...notesRef.current }; delete nn[ukey];
      notesRef.current = nn; setUserNotesOverlay(nn);
    }
    persistOverlays();
  }, [persistOverlays]);

  // Tag-as-flag: tagging an item into a group also flags it (you grouped it
  // because it's noteworthy), so the tag editor can stand alone without a
  // separate flag step. Untagging never unflags — the flag is the auditor's, and
  // they may keep it after removing a tag.
  const tagTarget = React.useCallback((targetKey, groupId) => {
    if (!targetKey || !groupId) return;
    let changed = false;
    if (!flaggedRef.current[targetKey]) {
      flaggedRef.current = { ...flaggedRef.current, [targetKey]: true };
      setFlaggedOverlay(flaggedRef.current);
      changed = true;
    }
    const cur = tagsRef.current[targetKey] || [];
    if (!cur.includes(groupId)) {
      tagsRef.current = { ...tagsRef.current, [targetKey]: [...cur, groupId] };
      setGroupTagsOverlay(tagsRef.current);
      changed = true;
    }
    if (changed) persistOverlays();
  }, [persistOverlays]);

  const untagTarget = React.useCallback((targetKey, groupId) => {
    const cur = tagsRef.current[targetKey] || [];
    if (!cur.includes(groupId)) return;
    const kept = cur.filter((g) => g !== groupId);
    const next = { ...tagsRef.current };
    if (kept.length) next[targetKey] = kept; else delete next[targetKey];
    tagsRef.current = next;
    setGroupTagsOverlay(next);
    persistOverlays();
  }, [persistOverlays]);

  // Wipe the auditor's accumulated session state back to a clean slate:
  //   * every trace's persisted markups (visited / flagged / notes) in
  //     localStorage — not just the current trace, since "reset cache" reads as
  //     global, and other traces load their (now-cleared) markups on next select;
  //   * the live in-memory overlays for the current trace;
  //   * the navigation position — back to the dossier with no commit selected.
  // The browser's back/forward *stack* can't be purged programmatically, so we
  // replaceState a fresh default tuple onto the current entry; older entries
  // remain reachable but restore into the now-empty markups.
  const resetCache = React.useCallback(() => {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.startsWith('redlogs:overlays:')) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch { /* disabled / inaccessible storage — in-memory reset still applies */ }
    visitedRef.current = {};
    flaggedRef.current = {};
    notesRef.current = {};
    dismissedRef.current = {};
    groupsRef.current = {};
    tagsRef.current = {};
    setVisitedOverlay({});
    setFlaggedOverlay({});
    setUserNotesOverlay({});
    setDismissedOverlay({});
    setUserGroupsOverlay({});
    setGroupTagsOverlay({});
    setCurrentId(null);
    setScreen('dossier');
    setAreaFocus(null);
    window.history.replaceState({ input: inputRef.current, screen: 'dossier', id: null, focus: null }, '');
  }, []);

  const value = React.useMemo(() => {
    const actions = { navigate, goScreen, openCommit, openThread, openArea, openUserGroup, openGroup, openDoc, recordFocus, toggleFlag, toggleDismiss, setDismissed, addUserNote, updateUserNote, deleteUserNote, createUserGroup, renameUserGroup, deleteUserGroup, tagTarget, untagTarget, selectInput, resetCache };
    // Raw markup overlays, exposed so non-chunk targets (semantic areas /
    // threads, keyed by their own ids) can read their notes/flags/dismissals by
    // key — chunks fold theirs into the derived chunk objects below instead.
    // userGroupsOverlay / groupTagsOverlay are the auditor's group registry and
    // membership map, read by the tag editor and the user-groups views.
    const baseFields = { inputs, selectedInput, currentId, screen, areaFocus, userNotesOverlay, flaggedOverlay, dismissedOverlay, userGroupsOverlay, groupTagsOverlay, showAiSuspicion, ...actions };
    if (state.status !== 'ready') return { ...state, ...baseFields };
    const data = state.data;
    const chunks = data.chunks.map((c) => {
      const userFlag = !!flaggedOverlay[c.id];
      const flagged = c.flagged || userFlag;
      return {
        ...c,
        visited: visitedOverlay[c.id] ? true : c.visited,
        flagged,
        userFlagged: userFlag,
        suspicionDismissed: !!dismissedOverlay[c.id],  // auditor dismissed the agent suspicion
        userNotes: userNotesOverlay[c.id] || [],
      };
    });
    const byId = Object.fromEntries(chunks.map((c) => [c.id, c]));
    const visitedCount = chunks.filter((c) => c.visited).length;
    const susSeen = chunks.filter((c) => c.visited).reduce((s, c) => s + (c.suspicion || 0), 0);
    // `fullData` is the complete, overlay-merged dataset; `data` is the gated
    // view every screen renders (AI suspicion neutralized when off). The export
    // deliverable reads `rawData` so it stays complete regardless of the toggle.
    const fullData = {
      ...data,
      chunks,
      byId,
      coverage: { ...data.coverage, visited: visitedCount, susSeen },
    };
    return {
      status: 'ready',
      error: null,
      data: withSuspicionGate(fullData, showAiSuspicion),
      rawData: fullData,
      ...baseFields,
    };
  }, [state, inputs, selectedInput, currentId, screen, areaFocus, showAiSuspicion, visitedOverlay, flaggedOverlay, userNotesOverlay, dismissedOverlay, userGroupsOverlay, groupTagsOverlay, navigate, goScreen, openCommit, openThread, openArea, openUserGroup, openGroup, openDoc, recordFocus, selectInput, toggleFlag, toggleDismiss, setDismissed, addUserNote, updateUserNote, deleteUserNote, createUserGroup, renameUserGroup, deleteUserGroup, tagTarget, untagTarget, resetCache]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
