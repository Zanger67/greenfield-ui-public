# AGENTS.md

Instructions for a code agent helping a human audit one of these traces.

## What a trace is

A trace is one directory, and it sits in one of two places (the UI treats them
as peers):

- **Dropped** — `public/data/<trace>/`, a subdirectory carrying `metadata.json`.
- **Surrounding** — when this repo is self-hosted *inside* a trace's own output
  folder, the trace's dirs sit one level **up** at `../` (the
  `dev_with_sample/ui/` → `dev_with_sample/` layout; the `../codebase/` +
  `../commit_builder_metadata/` marker pair is what signals it).

Paths below are written `public/data/<trace>/…` for brevity; in the surrounding
case substitute `../…` (so `../codebase/`, `../logs/`,
`../commit_builder_metadata/`, `../audit/`, and `git -C ../codebase …`). Two
things matter to you:

- `logs/` — the raw, untouched logs of the agent's session.
- `codebase/` — a **full git repository** with one commit per event from those
  logs. The commits are in chronological order. The working tree at HEAD is the
  final state.

There is also `final_codebase/` (the end state, no `.git`), `main_results/`
(what the agent reported as its result), and human-written reports at the trace
root (`blue_team_report.md`, `experiment_description.md`,
`guide_to_my_experiments.md`, `README.md`).

## How to investigate

**Always use both sources.** The logs say what the agent *did*; the git history
says what the bytes *actually changed*. Cross-check them — annotations are
generated from the logs and can be wrong, lossy, or incomplete.

In `public/data/<trace>/codebase/`:

```sh
git log --oneline                  # chronological dossier
git log -p <path>                  # follow one file through the trace
git show <sha>                     # what one commit changed
git diff <shaA> <shaB>             # range diff
git log --grep='\[BASH\]'          # filter by event type
git log --grep='\[DELETE\]'
```

In `public/data/<trace>/logs/`:

- `audit.jsonl` / `commands.jsonl` — structured event streams.
- `diffs/` — one diff file per file write.
- `terminal_logs/pane_*.log` — what the human saw on each terminal pane.
- `terminal_logs/claude_tools.jsonl` — tool calls the agent made.

## Sidecar JSONL — `commit_builder_metadata/`

These files are derived from the logs and keyed by commit sha. Read them when
the human asks about flags, annotations, suspicion, threads, or semantic areas.
Treat them as **hints, not ground truth** — confirm anything important against
the logs and the diffs.

- `event_commit_map.jsonl` — one record per event: `event_id`, `source`
  (`audit` / `commands` / `claude_tools`), `ts`, `inner_commit_sha`, and the
  raw event payload. This is the chronological spine.
- `bash_index.jsonl` — pane/session context for shell-command events.
- `flags.jsonl` — deterministic anomaly flags (`add_then_remove`,
  `run_scrapped`, …) per commit.
- `commit_sidecar.jsonl` — per-commit classification: mutating vs. read-only,
  group membership for collapsed edit-sequences.
- `annotations.jsonl` — see below.
- `thread_annotations.jsonl` — semantic threads spanning many (often
  non-adjacent) commits, with per-commit beat notes.
- `suspicions.jsonl` / `aggregated_suspicions.jsonl` — the LLM suspicion pass:
  per-commit suspicion buckets, and the semantic-area anchors + evidence built
  on top of them.
- `overall_rating.json` — single overall rating bucket for the trace.

## Auditor annotations — `<trace>/audit/`

Written **inside the trace's own directory**, resolved from the same trace `name`
the git endpoints use: `public/data/<trace>/audit/` for a dropped trace, or
`../audit/` when this repo is self-hosted inside a trace folder (i.e.
`../../<trace>/audit/`). The audit UI mirrors the human auditor's own working
state to disk as they work (the running dev server writes it on change). It's
gitignored / outside the repo, so it may be **absent on a fresh clone** — it
appears once someone opens the trace in the UI.

**If `audit/` is absent or empty — degrade gracefully, don't error or invent.** A
fresh clone, or a trace nobody has opened in the UI yet, has no audit store at all;
and even an opened trace has *no record* for an item the auditor never flagged,
noted, or grouped (a record exists only once one of those happens). So a handed-off
pointer may not resolve in the overlay. When it doesn't:

- A `commit:<sha>` / `area:<id>` / `thread:<id>` anchor is still fully resolvable —
  those ids are shared with the AI layer, so go straight to the substrate via the
  bridge table below: `git -C codebase show <sha>` + `annotations.jsonl` /
  `suspicions.jsonl` for a commit, `aggregated_suspicions.jsonl` for an area,
  `thread_annotations.jsonl` for a thread. You lose only the auditor's own
  notes/flags, not the object itself — investigate it from the sidecar + git.
- A **user tag-group** anchor (resolved by name) lives *only* in the audit store —
  it has no AI-sidecar equivalent. If `audit/` is missing, say so plainly rather
  than guessing: the group can't be resolved because the auditor's working state
  hasn't been written yet (it's created when the trace is opened in the UI).

These are the **auditor's own** flags, notes, dismissals and groupings — distinct
from the LLM-produced `commit_builder_metadata/` sidecars above. Treat them as
**the human's working hints, not ground truth**: confirm anything important
against the logs and the diffs in `codebase/`, same as the AI sidecars. Do not
hand-edit the `items/`, `groups/`, or `status/` files — the UI overwrites them
from the live state on the next change.

```
<trace>/audit/                    # e.g. public/data/<trace>/audit/ (or ../audit/)
  manifest.json                   # schema_version + file inventory + key scheme + counts
  items/                          # one file per KIND; one record per item, notes inlined
    commits.jsonl
    threads.jsonl
    areas.jsonl
    files.jsonl                   # result documents
    plots.jsonl
    sidecar_groups.jsonl          # AI commit-builder groups the auditor marked
  groups/
    user_groups.jsonl             # the auditor's own groups — a typed index of pointers
  status/                         # review status, not authored items
    coverage.json
    dismissals.jsonl
  local_ai/                       # YOU write here (see below) — never overwritten by the UI
    local_ai_commits.jsonl
    local_ai_threads.jsonl        # …one per kind, mirroring items/
  activity/                       # append-only session log (see below) — never overwritten
    activity.jsonl
  AI_AUDIT.md                     # rendered digest — read this first
```

### The one rule that makes this queryable: `target_key`

Every record in every file carries `schema_version` (currently `2`), `source`,
`trace`, and a uniform **`target_key`** of the form `<kind>:<id>`:

| kind | target_key | also carries |
| --- | --- | --- |
| commit | `commit:<event_id>` | `inner_commit_sha` (full 40-char, may be null), `event_id` |
| thread | `thread:<thread_id>` | `commit_shas[]`, `thread_id` |
| area | `area:<area_id>` | `commit_shas[]`, `anchor_sha`, `inner_commit_sha` (= anchor) |
| doc (file) | `doc:<doc_id>` | `path` |
| plot | `plot:<plot_file>` | `path` |
| sidecar group | `group:<group_id>` | `commit_shas[]`, first `inner_commit_sha`, `last_sha` |

Join **across audit files by `target_key`**, and **onto the AI sidecar + git** by
`inner_commit_sha` / `commit_shas` / `event_id` / `thread_id` / `area_id` /
`group_id` (the bridge table below). `manifest.json` lists the files + per-kind
counts. Read `AI_AUDIT.md` first for the human's picture, then the JSONL for joins.

Each **item record** (`items/*.jsonl`) is self-contained: a `flagged` bool, inline
`notes[]` (`{note_id, text, created_at, edited_at}`), and the `tagged_group_ids` /
`tagged_group_names` of the user-groups it's in. An item appears here when the
auditor **flagged it, noted it, OR tagged it into a group** — so a record may exist
with `flagged:false, notes:[]` purely because it's a group member. That guarantee
is what makes the traversal below complete.

A **user-group record** (`groups/user_groups.jsonl`) is a thin index:
`{ group_id, name, color, flagged, notes[], member_count, members:{ commits, threads,
areas, files, plots, sidecar_groups }, commit_shas[] }`. The `members.*` buckets are
**pure `target_key` pointers** into `items/*.jsonl`; `commit_shas` is the derived
rollup of *every* commit hash the group transitively touches (direct member commits
+ member threads'/areas'/sidecar-groups' `commit_shas`).

`status/dismissals.jsonl` — AI suspicions the auditor reviewed and cleared. A
**negative signal**: don't re-raise unprompted. `status/coverage.json` —
visited/total snapshot + session headline counts + last-sync time.

`activity/activity.jsonl` — the **append-only** session log: one record per UI
action, in order (the UI *overwrites* `items/`+`groups/`+`status/` with the current
state; this only grows). Each line: `t` (ISO), `type`, `trace`, `screen`, + a
per-type payload — `nav` (`from`/`to` `{input,screen,id,focus}`), `flag` / `dismiss`
/ `dismiss-batch`, `note-add` / `note-edit` / `note-delete`, `group-create` /
`group-rename` / `group-delete`, `tag` / `untag`, `settings` (`{key,value}`), `copy`
(`chars` + 80-char `preview`), `reset-cache`. A *behavioural* signal — what the
auditor looked at and when — not ground truth.

### Standard query — `expand(anchor)`

The human points you at an **anchor** — often via the audit UI's **copy** button,
which hands you a one-line pointer: a kind + label + an *audit pointer* (`area:<id>`,
`thread:<id>`, `commit:<id>` with its `inner_commit_sha`, `group:<id>`, or a tag-group
by **name**). That pointer *is* the anchor — resolve it against the live records here,
not from any annotation text pasted into the prompt; this store is authoritative and
current. Run the *same* bounded fan-out every time; it reaches the full transitive
context — including a note on a commit that's only a member of a thread that's a member
of the anchor group.

1. **Seed.**
   - group name → `jq 'select(.name=="<name>")' groups/user_groups.jsonl`
   - thread/area/commit → `jq 'select(.target_key=="<kind>:<id>")' items/<kind>.jsonl`
     (or a commit by `select(.inner_commit_sha=="<sha>") items/commits.jsonl`).
2. **Collect** from each visited record: its inline `notes[]`, `flagged`, ids.
3. **Expand**, deduping by `target_key`/sha:
   - has `tagged_group_ids` → read those `groups/user_groups.jsonl` records →
     enqueue every `members.*` pointer + the group's `notes` (its `commit_shas`
     is the one-shot hash set).
   - is a thread/area/sidecar_group → enqueue each of its `commit_shas`.
   - have a sha → `jq 'select(.commit_shas|index("<sha>"))' items/threads.jsonl items/areas.jsonl`
     (containing contexts) **and** `select(.inner_commit_sha=="<sha>") items/commits.jsonl`.
4. **Resolve** the sha frontier in `items/commits.jsonl` → collect those notes.
5. **Stop** when nothing new. Stop after step 3 for "direct context," or run to
   fixpoint for "everything associated."
6. **Ground truth** for any id via the bridge table.

```sh
# group name → every commit hash it transitively touches, in one read
jq -r 'select(.name=="data leakage").commit_shas[]' groups/user_groups.jsonl
# group name → its member pointers, by kind
jq 'select(.name=="data leakage").members' groups/user_groups.jsonl
# a commit → its notes + which groups it's in
jq 'select(.inner_commit_sha=="<sha>") | {notes, tagged_group_ids}' items/commits.jsonl
# resolve those hashes to diffs
jq -r 'select(.name=="data leakage").commit_shas[]' groups/user_groups.jsonl \
  | xargs -I{} git -C public/data/<trace>/codebase show {}
```

**Confirm scope first.** When handed a tag-group by name, echo back a one-line
validation report before investigating: the group **name**, `member_count` broken
down **by kind** (the `members` bucket lengths), and the `commit_shas` range
(first … last). Only proceed once it matches what the human meant.

### Bridge to the AI sidecar / git

The auditor's marks are overlays on the **same objects** the AI layer defines, so
they share ids — "go deeper" is one id-join, never a fuzzy match:

| audit item | id field | → AI sidecar / git |
| --- | --- | --- |
| commit | `inner_commit_sha` | `git -C codebase show <sha>`; `commit_builder_metadata/annotations.jsonl`, `suspicions.jsonl` |
| commit | `event_id` | `commit_builder_metadata/event_commit_map.jsonl` |
| thread | `thread_id` | `thread_annotations.jsonl` (full beat-narrative + complete commit list) |
| area | `area_id` | `aggregated_suspicions.jsonl` |
| sidecar group | `group_id` | `commit_sidecar.jsonl` / `semantic_clusters.jsonl` |

A user-flagged thread *is* the AI thread of that `thread_id`; a marked sidecar
group *is* the AI group of that `group_id`. The audit store is the overlay; the
sidecar is the substrate.

### Contributing your own records — `local_ai/`

When the human asks you to record a discovery ("note this", "flag this commit for
me"), **append** a JSONL record to the matching kind file under
`<trace>/audit/local_ai/` (`local_ai_commits.jsonl`, `local_ai_threads.jsonl`, …).
Mirror the `items/` record for that kind — same `target_kind` / `target_key` / id
fields / inline `notes[]` — but set:

- `source: "local_ai"`,
- `instructed_by_user: true` (you only write when the human asked),
- `surfaced: false` (reserved: a future UI step flips this when it surfaces your
  record back to the auditor).

Always include `target_key` (and `inner_commit_sha` for a commit) so your record
joins the same way the auditor's do. **Append whole records — never rewrite or
delete `items/`, `groups/`, `status/`, or `manifest.json`** (the UI owns those and
overwrites them). The `local_ai/` subdir is yours; the UI does not touch it.

## Agent annotations

`annotations.jsonl` is produced by an LLM annotation pass over the logs and the
diffs. Each record describes "what is happening" at one commit or one group:

```jsonc
{
  "agent_id": "consolidator",
  "target_kind": "commit" | "group",
  "inner_commit_sha": "<sha>",
  "group_id": "g0010" | null,
  "event_id": "<sha or group id>",
  "activity": "config" | "evaluation" | "edit" | ...,
  "annotation": "Updates config.py to change the qwen3-14b model ID …",
  "short_title": "Fix qwen3-14b model ID in config.py",
  "span_shas": ["<sha>", ...],
  "annotation_id": "ann-…"
}
```

Use them as a starting point: they tell you what the annotator *thought* the
agent was doing. Verify against the actual diff in `codebase/` and the raw
events in `logs/` before reporting it as a fact to the human.

`thread_annotations.jsonl` is the same idea at a higher level — one record per
*line of work* across several commits, with a label, the commits in the thread,
and a written-out beat-by-beat narrative.

## Rules of thumb

- When asked "what does this commit do" — `git show <sha>` first, then check
  the annotation for context.
- When asked "where did X go wrong" — get the suspicion buckets from
  `suspicions.jsonl`, look at the high-suspicion commits, follow the file with
  `git log -p`, then read the relevant log lines.
- When asked "what was the agent told to do" — `experiment_description.md`
  and `guide_to_my_experiments.md` at the trace root.
- Don't modify files under `public/data/<trace>/`. The codebase is a git repo
  but it's the artifact under audit, not a working branch.
