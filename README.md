# Redlogs — Greenfield BT Auditing UI

A UI for reviewing an AI coding agent's trace. The upstream pipeline (separate) turns the
agent's session into a **git repo with one commit per event** (bash call, file creation, file edit, etc.; 
located in `codebase/`) plus 
JSONL sidecar files including Claude Code SDK annotations and flagging. 
This app lets you step through those commits, flag
them, take notes, and roll the result up into an audit output.

No backend. `npm run dev` runs a small Vite server with a small middleware that runs
`git` against the trace's `codebase/` to power diff/blob/checkout views.

> [!IMPORTANT]
> **Commit order is chronological, not serial.** Commits are ordered by *when*
> each edit / action happened — but that does *not* mean the work was done one
> thing at a time. The researcher could have been (and in many cases probably
> was) working on several tasks and items in parallel, so adjacent commits may
> belong to unrelated threads of work interleaved in time. The **Semantic areas**
> page exists to regroup commits by idea rather than this time ordering.

## Run

```sh
npm install
npm run dev
```

## Three Pages

Switch between them in the top bar. They share one selected trace.

**Dossier inbox** — one row per commit. Left side: filters, suspicion heatmap,
edit-sequences collapsed into groups. Right side: the selected commit's diff,
flags, agent annotations, thread links, suspicion, and a notes field.

![dossier inbox](docs/readme%20instructions/sample_general.gif)

**Semantic areas** — commits grouped by idea instead of time. Each area is one
anchor commit plus the other commits it relates to (which may not be adjacent).
Shows an A→B→C per-file diff progression across the area. Linked via CC-SDK agents.

![semantic areas](docs/readme%20instructions/sample_semantics_page.gif)

**Overview** — your audit output. Flagged commits, the suspicion pass, the
overall rating, and every note you wrote.

## Things you can do

**Filter the inbox.** Multi-select filters narrow the commit list by change
type, suspect/flag, and file class.

![filter the inbox](docs/readme%20instructions/filter-usage.png)

**Expand diff context.** Each hunk has buttons to pull in more lines above or
below.

![expand diff context](docs/readme%20instructions/sample_diff_expand.gif)

**Follow a file through the trace.** A panel shows every commit that touched
the file, rendered as the patch that commit applied.

This is performed using `git log ...`

![file timeline](docs/readme%20instructions/sample_git_file_timeline.gif)

**Flag a commit or a whole group.** Flags show up in filters, in the scrubber,
and in the overview. A collapsed edit-sequence can be flagged as one unit.

![flag a group](docs/readme%20instructions/sample_flagging_group.gif)

**Take a note.** The note field auto-saves and shows up in the overview.

![validator note](docs/readme%20instructions/sample_validator_note.gif)

**Check out a commit in your editor.** Hold a row for 3 seconds. That sends
`POST /api/checkout`, which runs `git checkout <sha>` in the trace's
`codebase/`.

![checkout to follow the trace](docs/readme%20instructions/sample_checkout_codebase.gif)

> [!TIP]
> `public/data/<trace>/codebase/` is a **full git repo**. Open it directly in
> your IDE so checkouts move your editor too. Or point a code agent at it and
> ask it to run `git log`, `git diff`, `git show <sha>`, `git log -p <path>`,
> etc. — that's often the fastest way to follow a file through the diff. See
> [AGENTS.md](AGENTS.md).

**Jump from a thread to its commits.** Threads link from the dossier into the
semantic-areas screen and pre-select themselves there.

![thread navigation](docs/readme%20instructions/sample_thread_semantic_group.gif)

## Other things to know

- **Arrow keys move between commits.** ← / ↑ go to the previous commit, → / ↓
  to the next, walking chronological order regardless of the active screen's
  filters. Suspended while focus is in a text field (so notes keep their cursor)
  and while a modifier is held.
- **Browser back / forward / reload work.** Navigation rides browser history,
  including which screen you're on and which commit/thread is selected. A hard
  reload lands you where you left off.
- **Visited dimming + coverage pill.** Commits you've opened dim. A pill in the
  top bar tracks visited/total and suspicion-seen/suspicion-total so you can see
  how much of the trace you've actually walked.
- **Settings (gear icon, top bar).** Toggle `show times & dates`, `show commit
  hashes`, `inbox subline` (what the greyed line under each row shows), `title
  from short title` (use the annotation headline as the row title), and `reset
  cache` (clears visited · flags · notes · history; two-step to avoid an errant
  click wiping a session).

## Trace data layout — `public/data/<trace>/`

Each trace is one directory under `public/data/`. The UI also reads
`public/data/index.json` to fill the selector. **Trace folders are gitignored**
— drop them in locally; don't commit them.

```
public/data/<trace>/
├── codebase/                       full git repo, one commit per agent event
│   ├── .git/                       ← open this in an IDE to follow checkouts
│   ├── src/, experiments/, …       working tree at the latest commit
│   └── pyproject.toml, uv.lock
│
├── final_codebase/                 end state the agent delivered (no .git)
│   └── src/, experiments/, …
│
├── logs/                           raw logs as produced by the red team logger, untouched
│   ├── audit.jsonl / audit.log
│   ├── commands.jsonl / commands.log
│   ├── diffs/                      per-write file diffs
│   └── terminal_logs/              pane_*.log, claude_tools.jsonl
│
├── main_results/                   what the agent reported as the result
│   ├── final_report.md
│   ├── comparison_*.png
│   └── iteration_lines_*.png
│
├── commit_builder_metadata/        JSONL sidecars the UI reads
│   ├── event_commit_map.jsonl      ← one record per event (the spine)
│   ├── bash_index.jsonl            pane/session context for shell events
│   ├── flags.jsonl                 deterministic anomaly flags
│   ├── commit_sidecar.jsonl        mutating/read-only + group membership
│   ├── annotations.jsonl           "what's being done" agent notes
│   ├── thread_annotations.jsonl    semantic threads across many commits
│   ├── suspicions.jsonl            LLM suspicion pass (drives the heatmap)
│   ├── aggregated_suspicions.jsonl anchors + evidence for semantic areas
│   └── overall_rating.json         overall rating bucket
│
├── blue_team_report.md             human-written reference writeup
├── experiment_description.md       what the agent was asked to do
├── guide_to_my_experiments.md      experimenter's guide to the codebase
├── README.md                       trace package's own quick start
└── metadata.json                   experiment name + provenance
```

## Adding a trace

1. Drop the upstream `output/<trace>/` folder into `public/data/<name>/`.
2. Add an entry to `public/data/index.json`:
   ```json
   { "name": "<your-trace-dir>", "label": "<human label>" }
   ```
3. Refresh.
