# Redlogs — Greenfield BT Auditing UI

UI repo found at [github.com/Zanger67/greenfield-ui-public](https://github.com/Zanger67/greenfield-ui-public)

A blue-team UI for auditing a research project. An upstream pipeline
(separate repo) turns the agent's trace into a **git repo with one commit per
event** — every bash call, file creation, and file edit is its own commit, all
living in `codebase/`. A set of JSONL sidecar files carrying AI-Blue Team annotations, 
deterministic anomaly flags, and an LLM suspicion pass lives in `commit_builder_metadata/`, 
rendered by the UI. This app lets you step through those commits, flag them, take notes, 
group them, and handoff to local agents via the schema described in the `AGENTS.MD`.

**No backend.** `npm run dev` runs a small Vite server with middleware that shells
out to `git` against each trace's `codebase/` to power the diff / blob / file-log /
checkout views. There is no server, no auth, no database — the whole thing is a
single-URL static artifact you can hand to an external auditor.

> [!TIP]
> Click the `?` symbol at the top right anytime to see this page.

![Stepping through a trace in Redlogs with the arrow keys](docs/readme%20instructions/arrows_to_navigate.gif)

## What a processed trace looks like

The upstream pipeline emits one **processed-trace folder** per session — a single,
self-contained directory holding everything the UI needs: the reconstructed git
history, the raw logs it was rebuilt from, the agent's reported results, the
machine-readable sidecars, and (when the trace is shipped self-contained) the UI
itself dropped in as `ui/`.

```text
<trace>/                       one processed trace — one self-contained folder from the pipeline
├── codebase/                  reconstructed git repo — one commit per agent event (real .git)
├── final_codebase/            the end state the agent delivered (snapshot, no .git)
├── logs/                      raw red-team logger output the repo was rebuilt from —
│                              audit.jsonl/.log, commands.jsonl/.log, diffs/, terminal_logs/
├── main_results/              what the agent reported — final_report.md + result plots
├── commit_builder_metadata/   JSONL sidecars the UI reads — the per-event spine,
│                              annotations, deterministic flags, threads, suspicions
├── blue_team_report.md        human-written reference writeup
├── experiment_description.md  what the agent was asked to do
├── guide_to_my_experiments.md the experimenter's guide to the codebase
├── README.md                  the trace package's own quick start
├── metadata.json              experiment name + provenance (+ optional ui_name label)
├── audit/                     your markup, mirrored to disk as you work — AI_AUDIT.md
│                              (the deliverable) plus user/ flags·notes·groups and status/
└── ui/                        ← this app (Redlogs), when served from inside the trace
```

### Important directories

- **`codebase/`** is a real, walkable git repo — one commit per agent event — and
  it's what every diff / blob / file-log / checkout view shells out against.
  **`final_codebase/`** is just the delivered end state as a flat snapshot (no
  `.git`), for diffing against where the agent actually landed.
- **`logs/`** is the untouched red-team logger output the repo was reconstructed
  from; **`commit_builder_metadata/`** is the processed layer on top — the JSONL
  sidecars (event spine, annotations, flags, threads, suspicions) the UI actually
  reads.
- **`audit/`** is *yours*: the dev server mirrors your flags, notes, groups,
  coverage, and the rolled-up `AI_AUDIT.md` here as you work, so the deliverable
  lives beside the trace it describes.

The UI reads a trace in one of two arrangements — served from **inside** the trace
folder as `ui/` (the self-contained, one-folder-per-trace deliverable above), or
with traces **dropped under** the app's own `public/data/<trace>/`. Either way the
top-level contents are the same (minus `ui/`); see *Adding a trace* for how they're
discovered and *Trace data layout* below for the sidecar files in detail.

## Run

```sh
git clone https://github.com/Zanger67/greenfield-ui-public.git ui
cd ui
npm install
npm run dev
```

Then open the dev URL. Pick a trace from the **input** dropdown in the top bar and
start on the **timeline** tab.

---

## Mental model — read this first

A handful of design choices shape everything else in the UI:

- **One commit per agent event.** Each row in the timeline is a single edit, bash
  call, or tool invocation, reconstructed as a real git commit. The whole
  `codebase/` is a working git repo.

- **Order is chronological, not serial.** Commits are sorted by *when* each action
  happened — but that does **not** mean the agent did one thing at a time. The
  researcher may often work several tasks in parallel, working with several parallel agents, 
  so adjacent commits may belong to unrelated threads interleaved in time. 

- **The AI suspicion layer is off by default (anti-anchoring).** Notes from AI blue teaming
  are off by default. We highly recommend you start with your own passthroughs. The annotations 
  and suspicion flagging by prior agents is solely for additional supporting reference.
  The intent is that you form your own read of the trace first.

![Toggling the AI suspicion layer off and on from the top bar](docs/readme%20instructions/ai_flag_on_off.gif)


> [!TIP]
> `public/data/<trace>/codebase/` is a **full git repo**. You may optionally open it directly in your
> IDE. Clicking the *checkout* button will checkout the active commit locally. Or point a local AI agent at
> it and ask it to run `git log`, `git diff`, `git show <sha>`, `git log -p <path>`
> — often the fastest way to follow a file through the trace. We recommend referencing the [AGENTS.md](AGENTS.md) schema for agent navigation.

![Opening a trace's codebase/ git repo directly in an IDE](docs/readme%20instructions/ide_git_codebase_demo.gif)

> [!TIP]
> Everything you mark — flags, named groups, annotations, notes, coverage — is saved
> locally under `ui/audit/`, in the schema described by [AGENTS.md](AGENTS.md). Many
> spots in the UI double as **clickable copy-prompts**: clicking auto-copies a
> paste-ready reference to your clipboard that you can drop straight into a Claude Code
> context for a quick handoff. This includes the copy-refs (⧉) buttons, your **named
> groups**, and the **commit header** on the timeline — see [Handoff context to a local
> code agent](#handoff-context-to-a-local-code-agent).

---

## The top bar

Present on every screen:

- **input** — the trace selector. Traces are discovered live from the filesystem
  (see *Adding a trace*); switching keeps you on the current screen.
- **Screen tabs** — `timeline · threads & groups · final results · overview`.
- **Coverage** — `visited N / total`, how many commits you've visited in the UI.
- **AI flags** `off | on` — the master switch for the AI suspicion layer. Off by default.
- **?** — opens this help page.
- **🌙 / 🔆** — dark / light toggle.
- **⚙** — display & session settings popover (see the [settings table](#settings-reference)).

![The top bar — input selector, screen tabs, coverage, AI flags toggle, help, theme, and settings](docs/readme%20instructions/top_bar_configs.png)

---

## The four screens

They share one selected trace and one navigation history.

### Timeline

The primary triage surface: one row per commit, chronological.

- **Left pane** — the commit list with a filter bar and a heat-gutter minimap down
  the right edge. Edit-sequences are collapsed into group rows. Clicking the gutter
  jumps the list; visited commits dim.
- **Center pane** — the selected commit's dossier.
- **Right pane** — a **file timeline**: every commit that touched the open commit's
  file, each rendered as the patch it applied. Click any state to jump there.

### Threads & groups (semantic areas)

Commits regrouped by idea instead of time.

- **Left rail** — your user groups, AI-flagged areas (when AI flags on), and
  semantic threads.
- **Center** — the detail view. An **area** shows its suspicion metadata plus an
  **A→B→C per-file diff progression** across all its commits (intermediate states
  preserved). A **thread** shows its commits with per-commit beat notes. A **user
  group** shows its members.
- **Right** — the auditor panel: flag, notes, and tags for the selected item.

![The threads & groups screen — a group's members and per-file diff progression](docs/readme%20instructions/threads_and_groups.png)

When **AI flags** are on, the narrator's flagged semantic **areas** join the left rail —
each with its suspicion level, an anchor label, and the commits it spans.

![AI-flagged areas in the left rail, shown when AI flags are on](docs/readme%20instructions/ai_bt_auditor_flagged_areas.png)

### Final results

The researcher's deliverables and process docs.

- **Left nav** — documents grouped by stage (Results / Audit / Process): final
  report, blue-team report, experiment description, experiment guide.
- **Center** — rendered Markdown, or the **plots gallery** (a grid of result
  figures, each individually flaggable / notable).
- **Right** — the auditor panel for doc-level annotations.

### Overview

Your audit output, consolidated.

- A summary bar (flagged / notes / groups / total counts) with an **Export**
  button.
- **Flagged** items and **your other notes**, each row clicking through to its home
  screen.
- **Your user groups**, with member lists.
- The **AI suspicion ranking** and your **dismissed suspicions** — only when AI
  flags are on, and collapsed by default so your own read leads.

![The overview screen — flagged items, notes, and groups with an export button](docs/readme%20instructions/overview_page.png)

---

## Things you can do

### Follow a file through the trace

The file-timeline pane (timeline screen, right)
shows every commit that touched the current file, each as the patch it applied —
powered by `git log -p <path>` under the hood.

![Following a file through the trace in the file-timeline pane](docs/readme%20instructions/git_file_timeline.gif)

### Flag a commit, group, area, thread, or doc

Flags show up in the inbox filters,
the heat gutter, and the overview. A collapsed edit-sequence can be flagged as a
single unit. You can also name and group flagged items into your own groups, which
appear on the **threads & groups** tab — where each group's full compiled change
history and all its annotations are gathered in one place.

![Flagging a commit and tagging it into a group](docs/readme%20instructions/tagging_and_flagging_demo.gif)

### Build a user group by tagging

The tag editor fuzzy-matches existing groups or
creates a new one; add unrelated commits into a named bundle. Tagging an item also
flags it.

![Your user groups and semantic threads in the threads & groups left rail](docs/readme%20instructions/user_flagged_areas.png)

### Handoff context to a local code agent

Handoff isn't limited to a single commit —
most things in the UI are one click from a paste-ready reference on your clipboard.
Drop it into a Claude Code (or any local agent) context and it resolves against the
[AGENTS.md](AGENTS.md) schema in the trace. You can hand off:

- **A commit** — its copy-refs (⧉) button, or clicking the **commit header** on the
  timeline, copies a reference to that commit.
- **An area or thread** — its copy-refs (⧉) button copies a reference spanning all of
  its commits.
- **A named group** — clicking one of your groups copies a reference to the whole
  bundle, with its compiled change history and annotations.
- **The whole repo** — point the agent straight at `codebase/` and let it run
  `git log` / `git diff` / `git show` itself (see the IDE tip above).

![A code agent resolving the pasted reference via the AGENTS.md schema](docs/readme%20instructions/auto_prompt_demo_1.gif)

![Copying a paste-ready reference for a commit and a thread](docs/readme%20instructions/auto_prompt_demo_2.gif)

### Take a note

The notes field auto-saves and surfaces in the overview. Notes
carry created / edited timestamps and can be edited or deleted.

![Validator notes on the auditor panel — auto-saving, timestamped, deletable](docs/readme%20instructions/validator_note.png)


### Filter the inbox

Multi-select facets narrow the commit list by change type
(create / modify / delete / bash / tool / session / sync), flag state (your flags ·
your notes · ai flags · clean), and file class (code / data). A free-text box
filters on file-name substring. A reset button clears all conditions.

![Filtering the commit inbox by change type, flag state, and file class](docs/readme%20instructions/filters_sample.png)


### Check out a commit in your editor

Sends `POST /api/checkout`, which runs `git checkout <sha>` in the
trace's `codebase/`.

![Checking a commit out in your editor and stepping through the git graph](docs/readme%20instructions/git_checkout_demo.gif)

### Anonymous mode

A privacy screen for screenshots / screen-shares / external
demos: scrambles all *trace-derived* text (code, diffs, commands, annotations,
paths, the trace label) while preserving its silhouette — line breaks, indentation,
+/- gutters, word lengths.

### Faster navigation
- **Arrow keys** — `←/↑` previous commit, `→/↓` next, walking chronological order.
- **Browser history** — navigation (screen + selected commit/area/thread) rides the
  history stack, so back / forward / reload land you where you left off.
- **Resizable panes** — drag the thin dividers between panes; double-click a divider
  to reset it. Widths persist.

![Dragging the pane dividers to resize the timeline panes](docs/readme%20instructions/resizing_demo.gif)


---

## Settings reference

All settings persist in `localStorage` (`redlogs:settings`) and survive trace swaps,
reloads, and tab close. The two most consequential controls — **AI flags** and the
**theme** toggle — live in the top bar; the rest are under the **⚙** gear.

| Setting (key) | Where | What it does | Default |
| --- | --- | --- | --- |
| `showAiSuspicion` | top bar — **AI flags** pill | Master switch for the entire AI suspicion layer: narrator flag levels, the heat gutter, the suspect filter facet, flagged semantic areas, and the overview suspicion sections. When off, the data is gated at the source — not just hidden. | **off** |
| `darkMode` | top bar — **🌙/🔆** | Dark / light palette (a CSS-variable flip on `<html data-theme>`; applied pre-paint so there's no flash on load). | **on (dark)** |
| `showTimestamps` | gear — *show times & dates* | Literal date/time strings on edits and log items. Relationship signals ("N commits between", file order) stay visible regardless. | off |
| `showCommitHashes` | gear — *show commit hashes* | Short SHAs on list rows and headers (often the quickest cross-reference back to the trace). | off |
| `showLineNumbers` | gear — *show line numbers* | Old/new line-number gutter on source-file diffs. (Append-only log views have no hunk headers, so it doesn't apply there.) | on |
| `showAuditEventBox` | gear — *show audit event box* | The raw audit-event payload box (file / event / action / baseline) on file-edit dossiers — a low-level detail most of an audit doesn't need surfaced. | off |
| `inboxSubline` | gear — *inbox subline* | What the greyed second line under each inbox row shows: `operation` (raw audit op) · `short title` (annotation headline) · `description` (clipped "what's being done") · `none`. | `none` |
| `inboxTitleFromShortTitle` | gear — *title from short title* | Use the annotation agent's short headline as the row's primary line (instead of the touched file) when one exists. | on |
| `showTagFlagsHint` | gear — *tag-flags hint* | Shows the "adding a tag flags this …" reminder under each tag editor. A learn-once mechanic, so it's off once you know it. | off |
| `anonymize` | gear — *anonymous mode* | Scrambles all trace-derived text for safe screenshots; render-time only, underlying data untouched. | off |
| `paneWidths` | drag the pane dividers | Persisted sizes of the resizable panes. Defaults: inbox list 520 · file timeline 256 · areas sidebar 360 · auditor panel 320 · dossier notes 200 · results nav 280 (px). | per-pane |
| **reset cache** | gear — *session → reset* | Clears the auditor's accumulated state — visited · flags · notes · history — across **all** traces. Two-step (click → confirm) so an errant click can't wipe a session. | — (action) |

---

## Trace data layout — `public/data/<trace>/`

Each trace is one directory under `public/data/`. **Trace folders are gitignored** —
drop them in locally; don't commit them.

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
├── logs/                           raw logs from the red-team logger, untouched
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
└── metadata.json                   experiment name + provenance (+ optional ui_name)
```

## Adding a trace

Traces are discovered **live from the filesystem** by the dev-server middleware —
there's no index to hand-edit. Two sources appear together in the dropdown as peers:

1. **Dropped traces** — any subdirectory of `public/data/` containing a
   `metadata.json`. Drop the upstream `output/<trace>/` folder in as
   `public/data/<name>/` and reload — it appears.
2. **The surrounding trace** — if this repo is cloned *inside* a trace's output
   folder (so the trace's `codebase/` + `commit_builder_metadata/` sit at `../`),
   that parent is auto-detected and offered as one more option.
