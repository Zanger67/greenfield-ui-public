import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Git context is served per-trace. A trace dropped into public/data/<name>/
// mirrors the raw output layout (the whole `output/<trace>/` folder copied in
// verbatim), so its reconstruction repo lives at public/data/<name>/codebase.
// Every /api/* endpoint carries the selected input `name`; resolveRepo() maps
// it to that codebase. An input that ships without its own codebase/ has no
// repo to serve from, and the git endpoints report that rather than serving a
// shared fallback.
const PUBLIC_DATA = path.resolve(__dirname, 'public', 'data');

// Self-hosting fallback. When this repo is cloned *inside* a trace's output
// folder (e.g. as `<trace>/ui/`), the trace's own directories sit one level up
// at ../ — ../codebase, ../commit_builder_metadata, ../main_results, the
// experiment markdown, etc. With nothing dropped into public/data, the UI runs
// directly on that surrounding trace instead of a vendored copy. See
// parentTraceInput(): the marker is the pair every commit-builder output
// carries (codebase/ + commit_builder_metadata/), and the input takes the
// parent folder's own name — mirroring how public/data inputs are named for
// their dir.
const REPO_PARENT = path.resolve(__dirname, '..');

// Auditor-produced annotations are mirrored from the running UI to disk *inside
// the trace's own directory*, under <traceDir>/audit/, so a local coding agent
// reads them right next to the trace it audits (see POST /api/audit below). The
// trace dir is resolved from the input name exactly as the git endpoints resolve
// the codebase (see resolveTraceDir): a dropped trace at public/data/<name>/, or
// — when this repo is self-hosted inside a trace — the surrounding trace at ../.
// Either way the audit/ dir is gitignored or outside the repo, i.e. mutable
// working output. The allowlist is the fixed set of relative paths the UI may
// write: the auditor's own items (user/) and review status (status/), plus the
// rendered digest. The local_ai/ subdir is owned by the agent, never written here.
const AUDIT_SUBDIR = 'audit';
// The append-only UI activity log — a peer of user/ + status/, but written by a
// different endpoint (POST /api/audit-log) that APPENDS rather than overwrites.
// One fixed relative path (so it never takes attacker-controlled path input); it
// holds the chronological stream of auditor actions the running UI emits.
const ACTIVITY_LOG = 'activity/activity.jsonl';
const AUDIT_FILES = new Set([
  'manifest.json',
  'items/commits.jsonl',
  'items/threads.jsonl',
  'items/areas.jsonl',
  'items/files.jsonl',
  'items/plots.jsonl',
  'items/sidecar_groups.jsonl',
  'groups/user_groups.jsonl',
  'status/dismissals.jsonl',
  'status/coverage.json',
  'AI_AUDIT.md',
]);
// Pre-schema-v2 paths, removed on every write so a stale mirror from the old
// layout can't linger beside the new items/ store and mislead the agent. Fixed
// constant list (never attacker-controlled), joined under the resolved audit dir
// exactly like the allowlist — so path.join can't escape.
const LEGACY_AUDIT_FILES = [
  'user/user_flags.jsonl',
  'user/user_notes.jsonl',
  'user/user_groups.jsonl',
  'status/user_dismissals.jsonl',
];

const SHA_RE = /^[0-9a-f]{7,40}$/;
// Input names index a folder under public/data, so reject path separators and
// traversal — keep it to the characters trace dir names actually use.
const NAME_RE = /^[A-Za-z0-9._-]+$/;

// The surrounding trace, when this repo was cloned inside one (see REPO_PARENT).
// Detected by the same pair every commit-builder output carries — codebase/ +
// commit_builder_metadata/ both present at ../ — and named for the parent
// folder. Returns { name, dir } or null. Cheap stat()s, called per request; the
// filesystem is the source of truth so a folder appearing/disappearing is seen
// without a restart.
function parentTraceInput() {
  const name = path.basename(REPO_PARENT);
  if (!NAME_RE.test(name)) return null;
  const hasDir = (d) => {
    try { return fs.statSync(path.join(REPO_PARENT, d)).isDirectory(); }
    catch { return false; }
  };
  if (hasDir('codebase') && hasDir('commit_builder_metadata')) {
    return { name, dir: REPO_PARENT };
  }
  return null;
}

// Map an input name to its reconstruction repo: the dropped trace's own
// codebase/, detected by its `.git`. Returns null when the input carries no
// codebase of its own — the git endpoints then report a clean error instead of
// serving some other trace's repo. Falls back to the self-hosting parent
// trace's ../codebase when the name is that parent (see parentTraceInput).
function resolveRepo(name) {
  if (name && NAME_RE.test(name)) {
    const candidate = path.join(PUBLIC_DATA, name, 'codebase');
    if (fs.existsSync(path.join(candidate, '.git'))) return candidate;
    const parent = parentTraceInput();
    if (parent && parent.name === name) {
      const repo = path.join(parent.dir, 'codebase');
      if (fs.existsSync(path.join(repo, '.git'))) return repo;
    }
  }
  return null;
}

// Map an input name to its trace directory — the folder auditor annotations are
// mirrored into, under <traceDir>/audit/. Mirrors resolveRepo's resolution so
// the audit output lands next to the very trace the codebase endpoints serve:
// a dropped trace at public/data/<name>/ (marked, like discoverInputs, by its
// metadata.json), or — when this repo is self-hosted inside a trace folder — the
// surrounding parent trace at ../ (see parentTraceInput). Returns the absolute
// dir, or null when the name matches no known trace.
function resolveTraceDir(name) {
  if (!name || !NAME_RE.test(name)) return null;
  const dropped = path.join(PUBLIC_DATA, name);
  if (fs.existsSync(path.join(dropped, 'metadata.json'))) return dropped;
  const parent = parentTraceInput();
  if (parent && parent.name === name) return parent.dir;
  return null;
}

// A trace's display name (its dropdown label): metadata.json's "ui_name",
// trimmed, when set; otherwise the caller falls back to the directory name.
// Display-only — the input's `name` stays the directory name, which keys every
// /data and /api path and every localStorage overlay. Read live (file is tiny).
function readUiName(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
    const ui = meta && typeof meta.ui_name === 'string' ? meta.ui_name.trim() : '';
    return ui || null;
  } catch {
    return null;
  }
}

// Trace discovery. The selectable inputs are the subdirectories of public/data
// that hold a trace (marked by a metadata.json), PLUS — when this repo sits
// inside a trace's output folder — the surrounding parent trace (see
// parentTraceInput), which appears as a *peer* option, not a fallback: when both
// are present, all show in the dropdown. The dev middleware below synthesizes
// /data/index.json live from the filesystem (drop a folder in, reload, it
// appears) and the build hook writes it into dist/ so the static/preview path
// (no server, no filesystem read) keeps working too.
//
// Each input's `name` is its directory name (the stable path/key); its `label`
// is metadata.json's "ui_name" when set, else that same dir name. The list is
// sorted alphabetically by label, and the UI defaults to the LAST entry (see
// DataProvider) — with date-prefixed dir names that is the most recent trace.
function discoverInputs() {
  let entries;
  try {
    entries = fs.readdirSync(PUBLIC_DATA, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const inputs = entries
    .filter((e) => e.isDirectory() && NAME_RE.test(e.name)
      && fs.existsSync(path.join(PUBLIC_DATA, e.name, 'metadata.json')))
    .map((e) => ({ name: e.name, label: readUiName(path.join(PUBLIC_DATA, e.name)) || e.name, source: 'public/data' }));
  // The surrounding trace joins the public/data traces as a peer. Skip it only
  // when a dropped trace already claims the same name (public/data owns path
  // resolution for a name collision; see resolveRepo). `source` tells the client
  // where the trace's files sit on disk — public/data/<name>/ vs the parent (../) —
  // so handoff prompts can name that location for the coding agent (see traceLocation).
  const parent = parentTraceInput();
  if (parent && !inputs.some((i) => i.name === parent.name)) {
    inputs.push({ name: parent.name, label: readUiName(parent.dir) || parent.name, source: 'parent' });
  }
  inputs.sort((a, b) =>
    a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.name.localeCompare(b.name));
  return inputs;
}

function runGit(repo, args) {
  return new Promise((resolve) => {
    if (!repo) return resolve({ code: -1, stdout: '', stderr: 'no codebase for this input' });
    const git = spawn('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    git.stdout.on('data', (d) => { stdout += d; });
    git.stderr.on('data', (d) => { stderr += d; });
    git.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
    git.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runGitBinary(repo, args) {
  return new Promise((resolve) => {
    if (!repo) return resolve({ code: -1, body: Buffer.alloc(0), stderr: 'no codebase for this input' });
    const git = spawn('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    git.stdout.on('data', (d) => { chunks.push(d); });
    git.stderr.on('data', (d) => { stderr += d; });
    git.on('error', (err) => resolve({ code: -1, body: Buffer.alloc(0), stderr: err.message }));
    git.on('close', (code) => resolve({ code, body: Buffer.concat(chunks), stderr }));
  });
}

const MIME_BY_EXT = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
};

function mimeOf(path) {
  const i = path.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  return MIME_BY_EXT[path.slice(i).toLowerCase()] || 'application/octet-stream';
}

// Content types for the self-hosted parent trace's static files (the loaders
// read .text()/.json() on these, so the body is what matters — but the type
// must not be text/html, which every loader treats as the dev SPA-fallback
// miss). Data artifacts and markdown below; images reuse mimeOf.
const STATIC_TYPES = {
  '.json':  'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.md':    'text/markdown; charset=utf-8',
  '.txt':   'text/plain; charset=utf-8',
};
function staticContentType(p) {
  const i = p.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  const ext = p.slice(i).toLowerCase();
  return STATIC_TYPES[ext] || MIME_BY_EXT[ext] || 'application/octet-stream';
}

// Per-revision tree listing cache. `git ls-tree -r` is the slow part of path
// resolution; commit trees are immutable, so cache by repo + revspec for the
// life of the dev server (repo is in the key since different traces may share
// short shas).
const treeCache = new Map();
async function listTree(repo, shaSpec) {
  const key = repo + '\0' + shaSpec;
  if (treeCache.has(key)) return treeCache.get(key);
  // `-z` + quotePath=false keeps non-ascii / spaced paths intact.
  const { code, stdout } = await runGit(repo, [
    '-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--name-only', shaSpec,
  ]);
  const entries = code === 0 ? stdout.split('\0').filter(Boolean) : null;
  treeCache.set(key, entries);
  return entries;
}

// Resolve a possibly experiment-relative path to its full tree path within a
// revision. Trace events record paths relative to the agent's working dir
// (e.g. `_results/plots/foo.png`) while the git tree stores them under a
// prefix (`experiments/<trace>/_results/plots/foo.png`). Prefix-agnostic:
// try the path verbatim, then fall back to a unique tail match in the tree.
async function resolveTreePath(repo, shaSpec, p) {
  const norm = p.replace(/^\.?\//, '');
  const entries = await listTree(repo, shaSpec);
  if (!entries) return { path: norm };          // ls-tree failed; let cat-file report it
  if (entries.includes(norm)) return { path: norm };
  const matches = entries.filter((e) => e.endsWith('/' + norm));
  if (matches.length === 1) return { path: matches[0] };
  return { path: norm, ambiguous: matches.length > 1, matches };
}

// The empty blob's OID. Every file in the reconstruction repo is born as a
// 0-byte placeholder, so any rename/copy git "detects" *from* this blob is a
// false positive (two empty files are 100% identical at any threshold) — the
// file-history follower uses this to cut bogus cross-file chains.
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

// Full commit order for a repo: sha → ordinal (0 = newest). Used to report how
// many commits sit between two consecutive file-touch commits. The history is
// immutable for the dev server's life, so cache per repo.
const orderCache = new Map();
async function commitOrder(repo) {
  if (orderCache.has(repo)) return orderCache.get(repo);
  const { code, stdout } = await runGit(repo, ['rev-list', '--all']);
  const map = new Map();
  if (code === 0) stdout.split('\n').filter(Boolean).forEach((sha, i) => map.set(sha, i));
  orderCache.set(repo, map);
  return map;
}

function checkoutMiddleware() {
  // Captured from the resolved config so the build hook knows where dist is.
  let buildOutDir = null;
  return {
    name: 'trace-checkout',
    configResolved(config) {
      buildOutDir = path.resolve(config.root, config.build.outDir);
    },
    // Build path: emit the discovered manifest into dist/data so a server-less
    // static deploy (npm run preview, or any plain host) lists traces without a
    // live filesystem. public/data is copied into dist during the build, so by
    // closeBundle the dir exists; this just (over)writes its index.json.
    closeBundle() {
      if (!buildOutDir) return;
      const dest = path.join(buildOutDir, 'data');
      try {
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(
          path.join(dest, 'index.json'),
          `${JSON.stringify({ inputs: discoverInputs() }, null, 2)}\n`,
        );
      } catch (err) {
        this.warn?.(`failed to write data/index.json: ${err.message}`);
      }
    },
    configureServer(server) {
      // GET /data/index.json — synthesized live from the filesystem so dropping
      // a trace folder into public/data surfaces it on the next reload with no
      // manifest edit. Registered ahead of Vite's static/public middleware (and
      // there is no longer a real file at this path), so this always answers in
      // dev. The static build is covered by closeBundle above.
      server.middlewares.use('/data/index.json', (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-cache');
        res.end(JSON.stringify({ inputs: discoverInputs() }));
      });

      // GET /data/<parentName>/<path> — static files for the self-hosted parent
      // trace (see REPO_PARENT). These live OUTSIDE public/data (one level up at
      // ../), so Vite's own static middleware can't reach them; without this they
      // hit the SPA fallback (index.html at HTTP 200), which every loader reads
      // as a miss and the trace silently fails to load. Only the parent-trace
      // name is served here — all other /data/<name>/ paths fall through to
      // Vite's static serving of public/data. Registered after the index.json
      // handler so that exact path still wins.
      server.middlewares.use('/data', (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const parent = parentTraceInput();
        if (!parent) return next();
        // Mounted at '/data', so req.url is the remainder: '/<name>/<rest...>'.
        let pathname;
        try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
        catch { return next(); }
        const segs = pathname.split('/').filter(Boolean);
        if (segs.length < 2 || segs[0] !== parent.name) return next();
        const rest = segs.slice(1);
        // No traversal segments, and never resolve outside the parent trace dir.
        if (rest.some((s) => s === '.' || s === '..')) return next();
        const filePath = path.join(parent.dir, ...rest);
        if (path.relative(parent.dir, filePath).startsWith('..')) return next();
        let stat;
        try { stat = fs.statSync(filePath); } catch { stat = null; }
        if (!stat || !stat.isFile()) {
          // A clean 404 (not the SPA fallback) so the loaders' candidate-path
          // probing distinguishes "missing" from "is HTML".
          res.statusCode = 404;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          return res.end('not found');
        }
        res.setHeader('content-type', staticContentType(filePath));
        res.setHeader('content-length', String(stat.size));
        res.setHeader('cache-control', 'no-cache');
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(filePath).pipe(res);
      });

      // POST /api/checkout — body { sha, name } → `git checkout <sha>` in the
      // input's reconstruction repo.
      server.middlewares.use('/api/checkout', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
          let parsed;
          try { parsed = JSON.parse(body); }
          catch { res.statusCode = 400; return res.end('bad json'); }
          const { sha, name } = parsed;
          if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
            res.statusCode = 400; return res.end('bad sha');
          }
          const repo = resolveRepo(name);
          const { code, stderr } = await runGit(repo, ['checkout', sha]);
          res.setHeader('content-type', 'application/json');
          if (code === 0) {
            res.end(JSON.stringify({ ok: true, sha, repo }));
          } else {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: stderr.trim() || `git exit ${code}` }));
          }
        });
      });

      // POST /api/audit — body { name, files: { '<relpath>': '<content>' } }.
      // Mirrors the auditor's overlay state from the running UI to disk inside the
      // trace's own dir, under <traceDir>/audit/ (resolved from `name` like the
      // git endpoints' codebase — see resolveTraceDir). Writes ONLY the fixed
      // allowlist of relative paths (user/ + status/ + the digest); never the
      // local_ai/ subdir, which the agent owns. Whole-file overwrite per sync —
      // each request carries the complete current state, so no torn partial writes.
      server.middlewares.use('/api/audit', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          res.setHeader('content-type', 'application/json');
          let parsed;
          try { parsed = JSON.parse(body); }
          catch { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad json' })); }
          const { name, files } = parsed || {};
          if (typeof name !== 'string' || !NAME_RE.test(name)) {
            res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad name' }));
          }
          if (!files || typeof files !== 'object') {
            res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad files' }));
          }
          // Resolve to the trace's own directory and write under its audit/ — next
          // to the codebase the git endpoints serve, not a shared repo-root dir.
          const traceDir = resolveTraceDir(name);
          if (!traceDir) {
            res.statusCode = 404;
            return res.end(JSON.stringify({ ok: false, error: `no trace dir for '${name}'` }));
          }
          const dir = path.join(traceDir, AUDIT_SUBDIR);
          const written = [];
          try {
            for (const [rel, content] of Object.entries(files)) {
              // Filenames are validated against the fixed allowlist, never used as
              // raw attacker-controlled paths — so path.join can't escape the dir.
              if (!AUDIT_FILES.has(rel) || typeof content !== 'string') continue;
              const dest = path.join(dir, rel);
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, content);
              written.push(rel);
            }
            // Prune the pre-v2 layout: the endpoint never deletes files absent
            // from the payload, so without this the old user/ + status mirror
            // would persist next to the new store. force:true = no throw if absent.
            for (const rel of LEGACY_AUDIT_FILES) {
              fs.rmSync(path.join(dir, rel), { force: true });
            }
            try { fs.rmdirSync(path.join(dir, 'user')); } catch { /* not empty / already gone */ }
          } catch (err) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ ok: false, error: err.message }));
          }
          // Report the dir relative to the UI root: public/data/<name>/audit for a
          // dropped trace, ../audit for the self-hosted parent trace.
          res.end(JSON.stringify({ ok: true, dir: path.relative(__dirname, dir), written }));
        });
      });

      // POST /api/audit-log — body { name, events: [ {...}, ... ] }.
      // The append-only companion to /api/audit: instead of overwriting the
      // state mirror, this APPENDS each event as one JSONL line to the trace's
      // own <traceDir>/audit/activity/activity.jsonl (a single fixed path, never
      // attacker-controlled — see ACTIVITY_LOG). It's the chronological record of
      // what the auditor did (navigation, flags, notes, tags, settings, copies);
      // the UI batches a burst of actions into one request. Bounded: the body is
      // capped while reading and the batch is capped before writing, so a runaway
      // client can't write unbounded data.
      server.middlewares.use('/api/audit-log', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        let tooBig = false;
        req.on('data', (c) => {
          body += c;
          if (body.length > 1_000_000) { tooBig = true; req.destroy(); }
        });
        req.on('end', () => {
          res.setHeader('content-type', 'application/json');
          if (tooBig) { res.statusCode = 413; return res.end(JSON.stringify({ ok: false, error: 'too large' })); }
          let parsed;
          try { parsed = JSON.parse(body); }
          catch { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad json' })); }
          const { name, events } = parsed || {};
          if (typeof name !== 'string' || !NAME_RE.test(name)) {
            res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad name' }));
          }
          if (!Array.isArray(events)) {
            res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad events' }));
          }
          const traceDir = resolveTraceDir(name);
          if (!traceDir) {
            res.statusCode = 404;
            return res.end(JSON.stringify({ ok: false, error: `no trace dir for '${name}'` }));
          }
          // Re-serialize each event ourselves (one compact line apiece) rather
          // than trust the client's framing — guarantees well-formed JSONL and a
          // single trailing newline per record. Cap the batch as a backstop.
          let lines = '';
          let appended = 0;
          for (const ev of events.slice(0, 1000)) {
            if (!ev || typeof ev !== 'object') continue;
            try { lines += JSON.stringify(ev) + '\n'; appended++; }
            catch { /* non-serializable event — skip it */ }
          }
          const dest = path.join(traceDir, AUDIT_SUBDIR, ACTIVITY_LOG);
          try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            if (lines) fs.appendFileSync(dest, lines);
          } catch (err) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ ok: false, error: err.message }));
          }
          res.end(JSON.stringify({ ok: true, file: path.relative(__dirname, dest), appended }));
        });
      });

      // GET /api/blob?sha=<sha>&path=<path>&name=<input> → raw bytes of
      // `git cat-file -p <sha>:<path>`. Used by the dossier diff panel to
      // render image files inline. `sha` may include `~1` / `^` suffixes so
      // the parent revision can be fetched for side-by-side rendering.
      server.middlewares.use('/api/blob', async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const shaSpec = url.searchParams.get('sha') || '';
        const path = url.searchParams.get('path') || '';
        const repo = resolveRepo(url.searchParams.get('name'));
        if (!/^[0-9a-f]{7,40}(~\d+|\^)?$/.test(shaSpec)) {
          res.statusCode = 400; return res.end('bad sha');
        }
        if (!path || path.length > 1024 || path.includes('\0')) {
          res.statusCode = 400; return res.end('bad path');
        }
        const resolved = await resolveTreePath(repo, shaSpec, path);
        if (resolved.ambiguous) {
          res.statusCode = 409;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          return res.end(`ambiguous path '${path}' in ${shaSpec}:\n${resolved.matches.join('\n')}`);
        }
        const { code, body, stderr } = await runGitBinary(repo, ['cat-file', '-p', `${shaSpec}:${resolved.path}`]);
        if (code === 0) {
          res.setHeader('content-type', mimeOf(path));
          res.setHeader('content-length', String(body.length));
          res.setHeader('cache-control', 'no-cache');
          return res.end(body);
        }
        const notFound = /does not exist|exists on disk|Not a valid object name/.test(stderr);
        res.statusCode = notFound ? 404 : 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(stderr || `git exit ${code}`);
      });

      // GET /api/diff?sha=<sha>&name=<input> → text of `git show <sha>`
      // (commit header + patch).
      server.middlewares.use('/api/diff', async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const sha = url.searchParams.get('sha') || '';
        const repo = resolveRepo(url.searchParams.get('name'));
        if (!SHA_RE.test(sha)) { res.statusCode = 400; return res.end('bad sha'); }
        const { code, stdout, stderr } = await runGit(repo, [
          'show',
          '--no-color',
          '--format=fuller',
          '--stat',
          '--patch',
          sha,
        ]);
        if (code === 0) {
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(stdout);
        } else {
          res.statusCode = 500;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(stderr || `git exit ${code}`);
        }
      });

      // GET /api/groupdiff?from=<sha>&to=<sha>&name=<input> → text of the
      // *cumulative* patch a deterministically-parsed commit group produced:
      // `git diff <from>~1 <to>`, where `from` is the group's oldest commit and
      // `to` its newest. The group is a contiguous run of the linear history,
      // so this is the net change across every commit under the group. Falls
      // back to the empty tree as base when `from` is the root commit.
      server.middlewares.use('/api/groupdiff', async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const from = url.searchParams.get('from') || '';
        const to = url.searchParams.get('to') || '';
        const repo = resolveRepo(url.searchParams.get('name'));
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        if (!SHA_RE.test(from) || !SHA_RE.test(to)) { res.statusCode = 400; return res.end('bad sha'); }
        const diffArgs = (base) => ['diff', '--no-color', '--stat', '--patch', base, to];
        let { code, stdout, stderr } = await runGit(repo, diffArgs(`${from}~1`));
        if (code !== 0) {
          // `from` has no parent (root commit) — diff against the empty tree.
          const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
          ({ code, stdout, stderr } = await runGit(repo, diffArgs(EMPTY_TREE)));
        }
        if (code === 0) {
          res.end(stdout);
        } else {
          res.statusCode = 500;
          res.end(stderr || `git exit ${code}`);
        }
      });

      // GET /api/filediff?base=<rev>&target=<sha>&path=<path>&context=<n>&name=<input>
      //   → text of `git diff --no-color -U<n> <base> <target> -- <path>`: one
      // file's patch re-expanded with `n` lines of surrounding context, so the
      // auditor can read the code around a hunk without re-running the whole
      // commit's diff. `base` carries the same shape the diff panels already
      // hold — `<sha>~1` for a single commit, `<from>~1` for a group — and falls
      // back to the empty tree when that parent doesn't exist (root commit).
      server.middlewares.use('/api/filediff', async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const base = url.searchParams.get('base') || '';
        const target = url.searchParams.get('target') || '';
        const p = url.searchParams.get('path') || '';
        const ctxRaw = url.searchParams.get('context') || '';
        const repo = resolveRepo(url.searchParams.get('name'));
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        if (!/^[0-9a-f]{7,40}(~\d+|\^)?$/.test(base)) { res.statusCode = 400; return res.end('bad base'); }
        if (!SHA_RE.test(target)) { res.statusCode = 400; return res.end('bad target'); }
        if (!p || p.length > 1024 || p.includes('\0')) { res.statusCode = 400; return res.end('bad path'); }
        // Clamp context to a sane band; the 'full file' level sends a large value
        // git happily caps at the actual file length.
        const context = Math.min(Math.max(parseInt(ctxRaw, 10) || 3, 0), 100000);
        const diffArgs = (b) => ['diff', '--no-color', `-U${context}`, b, target, '--', p];
        let { code, stdout, stderr } = await runGit(repo, diffArgs(base));
        if (code !== 0) {
          const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
          ({ code, stdout, stderr } = await runGit(repo, diffArgs(EMPTY_TREE)));
        }
        if (code === 0) {
          res.end(stdout);
        } else {
          res.statusCode = 500;
          res.end(stderr || `git exit ${code}`);
        }
      });

      // GET /api/filelog?sha=<sha>&path=<path>&name=<input> → JSON history of
      // one path across the whole trace, newest-first:
      //   { path, entries: [{ sha, date, subject, status, from?, ord }] }
      // where `status` is A/M/D/R, `from` is the prior path on a rename, and
      // `ord` is the commit's position in the full repo history (0 = newest)
      // so the UI can show how many commits sit between consecutive entries.
      //
      // `--follow` is on so genuine renames are traced across path changes.
      // It is unsafe here on its own: the repo seeds files as identical 0-byte
      // placeholders, and `--follow`'s copy detection links any two empty
      // blobs (100% identical), fabricating a chain that hops across unrelated
      // files. We read `--raw` (which carries blob OIDs) and cut the follow at
      // the first rename/copy whose *source* is the empty blob — never a real
      // rename — recording that commit as the file's creation. With no genuine
      // renames present this yields exactly the plain-log result; when a real
      // rename appears (non-empty source) it is followed normally.
      // `sha` only resolves the (experiment-relative) path against a tree.
      server.middlewares.use('/api/filelog', async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const sha = url.searchParams.get('sha') || '';
        const p = url.searchParams.get('path') || '';
        const repo = resolveRepo(url.searchParams.get('name'));
        res.setHeader('content-type', 'application/json; charset=utf-8');
        if (!SHA_RE.test(sha)) { res.statusCode = 400; return res.end('{"error":"bad sha"}'); }
        if (!p || p.length > 1024 || p.includes('\0')) {
          res.statusCode = 400; return res.end('{"error":"bad path"}');
        }
        const resolved = await resolveTreePath(repo, sha, p);
        if (resolved.ambiguous) {
          res.statusCode = 409;
          return res.end(JSON.stringify({ error: 'ambiguous path', matches: resolved.matches }));
        }
        // \x00 separates commits; \x1f separates header fields. `--raw -M`
        // appends one `:<modes> <oldsha> <newsha> <STATUS>\t<path>[\t<newpath>]`
        // line per file change, giving us the blob OIDs the guard needs.
        const { code, stdout, stderr } = await runGit(repo, [
          '-c', 'core.quotePath=false',
          'log', '--all', '--follow', '--raw', '-M', '--abbrev=40',
          '--format=%x00%H%x1f%cI%x1f%s',
          '--', resolved.path,
        ]);
        if (code !== 0) {
          res.statusCode = 500;
          return res.end(JSON.stringify({ error: stderr.trim() || `git exit ${code}` }));
        }
        const order = await commitOrder(repo);
        const entries = [];
        for (const rec of stdout.split('\0')) {
          const block = rec.replace(/^\n+/, '');
          if (!block.trim()) continue;
          const nl = block.indexOf('\n');
          const head = nl < 0 ? block : block.slice(0, nl);
          const rest = nl < 0 ? '' : block.slice(nl + 1);
          const parts = head.split('\x1f');
          const h = parts[0];
          if (!h) continue;
          const date = parts[1] || '';
          const subject = parts.slice(2).join('\x1f');
          // First `:` raw line describes the change to the followed file.
          const rawLine = rest.split('\n').find((l) => l.startsWith(':')) || '';
          const segs = rawLine.replace(/^:/, '').split('\t');
          const meta = segs[0].split(/\s+/);          // [oldmode,newmode,oldsha,newsha,STATUS]
          const oldSha = meta[2] || '';
          let status = (meta[4] || '').charAt(0) || 'M';
          const paths = segs.slice(1);
          const destPath = paths[paths.length - 1];
          const fromPath = paths.length > 1 ? paths[0] : undefined;
          const ord = order.has(h) ? order.get(h) : null;

          // A rename/copy whose source is the empty blob is a placeholder
          // artifact, not a real rename: this commit is where the file was
          // first created (as an empty placeholder). Record it as an add and
          // stop following before the chain hops into an unrelated file.
          if ((status === 'C' || status === 'R') && oldSha === EMPTY_BLOB) {
            entries.push({ sha: h, date, subject, status: 'A', ord });
            break;
          }
          entries.push({ sha: h, date, subject, status, from: fromPath, ord });
        }
        res.end(JSON.stringify({ path: resolved.path, entries }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), checkoutMiddleware()],
  server: {
    port: 5173,
    open: false,
    // Dropped traces carry their own git repo (and codebases) under
    // public/data/<name>/. Don't let the dev server watch those — the .git
    // dirs and source trees are large and immutable for our purposes.
    watch: { ignored: ['**/public/data/**/codebase/**', '**/public/data/**/final_codebase/**'] },
  },
});
