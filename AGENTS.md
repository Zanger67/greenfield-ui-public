# AGENTS.md

Instructions for a code agent helping a human audit one of these traces.

## What a trace is

A directory under `public/data/<trace>/`. Two things matter to you:

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

These are the **auditor's own** flags, notes, dismissals and groupings — distinct
from the LLM-produced `commit_builder_metadata/` sidecars above. Treat them as
**the human's working hints, not ground truth**: they reflect what the auditor
flagged or wondered about mid-session and may be partial or change. Confirm
anything important against the logs and the diffs in `codebase/`, same as the AI
sidecars. Do not hand-edit the `user/` or `status/` files — they're overwritten
from the live UI on the next change.

```
<trace>/audit/                # e.g. public/data/<trace>/audit/ (or ../audit/)
  user/                       # auditor-authored items
    user_flags.jsonl
    user_notes.jsonl
    user_groups.jsonl
  local_ai/                   # YOU write here (see below) — never overwritten by the UI
    local_ai_notes.jsonl
    local_ai_groups.jsonl
    local_ai_flags.jsonl
  status/                     # review status, not authored items
    coverage.json
    user_dismissals.jsonl
  AI_AUDIT.md                 # rendered digest — read this first
```

Every JSONL record carries a `source` field. Commit- and group-scoped records
carry `inner_commit_sha` (full 40-char), so you can **left-join them onto
`commit_builder_metadata/event_commit_map.jsonl` / `annotations.jsonl` by
`inner_commit_sha`** (commits also carry `event_id`). Flags and dismissals have
no per-item timestamp (the source has none); `status/coverage.json` records the
last-sync time.

- `user/user_flags.jsonl` — one record per flagged target. `target_kind` ∈
  `commit` / `group` / `area` / `thread` / `doc` / `plot`. `tagged_groups` lists
  the auditor's user-group names the target is in.
- `user/user_notes.jsonl` — one record per free-text note, with `note_id`, the
  target (`event_id` + `inner_commit_sha`, or `area_id` / `thread_id` / `doc_id`
  / `plot_file` / `group_id`), `text`, `created_at`, `edited_at`, and the
  `tagged_groups` of its target.
- `user/user_groups.jsonl` — the auditor's own named groupings; each record has
  the group's `members` (resolved to `inner_commit_sha` where applicable) and any
  group-level `annotations`.
- `status/user_dismissals.jsonl` — AI suspicions the auditor reviewed and cleared.
  A **negative signal**: don't re-raise these unprompted.
- `status/coverage.json` — visited/total snapshot + session headline counts.
- `AI_AUDIT.md` — a rendered digest of all of the above; read it first for a fast
  picture of what the human cares about, then drill into the JSONL for joins.

**Querying across context.** Notes/flags carry their group/thread/area ids inline,
so a tag-group or thread is directly filterable. Examples:

```sh
# every note in a user group, across the human's + your own records
cat public/data/<trace>/audit/user/user_notes.jsonl public/data/<trace>/audit/local_ai/local_ai_notes.jsonl \
  | jq 'select(.tagged_groups // [] | index("data leakage"))'
# everything attached to thread A
jq 'select(.thread_id=="A")' public/data/<trace>/audit/user/user_notes.jsonl
# resolve a flagged commit back to the diff
jq -r 'select(.target_kind=="commit").inner_commit_sha' public/data/<trace>/audit/user/user_flags.jsonl \
  | xargs -I{} git -C public/data/<trace>/codebase show {}
```

**Confirm you scoped the right group before investigating.** When the human hands
you a tag group by name, first echo back a one-line validation report so they can
confirm you resolved the group they meant: the group **name**, its total member
count broken down **by kind** (commits/edits, areas, threads, docs/plots), and the
commit **sha range** (first … last). Pull these from the group's `members` array
in `user/user_groups.jsonl` and cross-check the `tagged_groups` index on
`user_flags.jsonl` / `user_notes.jsonl`. Only proceed once the counts look right.

### Contributing your own records — `local_ai/`

When the human asks you to record a local discovery ("add a note of this to the
logs", "flag this commit for me"), **append** a JSONL record to the matching file
under `<trace>/audit/local_ai/` (`local_ai_notes.jsonl`, `local_ai_flags.jsonl`,
`local_ai_groups.jsonl`). Mirror the `user/` schema for that kind, but set:

- `source: "local_ai"`,
- `instructed_by_user: true` (you only write when the human asked),
- `surfaced: false` (reserved: a future UI step flips this when it surfaces your
  record back to the auditor).

Always include `inner_commit_sha` when the target is a commit, so your record
joins onto the trace the same way the auditor's do. **Append whole records — never
rewrite or delete `user/` or `status/` files** (the UI owns those and will
overwrite them). The `local_ai/` subdir is yours; the UI does not touch it.

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
