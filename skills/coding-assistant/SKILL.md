---
name: coding-assistant
description: Run Codex or Claude Code as a managed background coding assistant with structured run artifacts, optional in-progress notifications, run status inspection, and graceful cancellation. Use when building features, refactoring code, fixing bugs, reviewing implementation plans, or running iterative coding work in a real project directory. Prefer this instead of the older coding-agent skill when you want detached execution, `result.json` / `run.log` / `status.json` artifacts, active run lookup, and completion or cancellation notifications back to Telegram or the current session. Do not use for tiny one-line edits, simple file reads, or thread-bound ACP harness requests in chat.
---

# Coding Assistant

Use the local `coding-agent-wrapper` project as the default execution layer for Codex / Claude Code coding tasks. The wrapper is the new preferred path because it gives you five things the old bash-first flow did not provide reliably:

1. detached background execution
2. stable run artifacts (`run.log`, `result.json`, `status.json`, optional `agent-summary.txt`, optional `agent-report.json`)
3. automatic completion notifications
4. optional in-progress notifications with cadence controlled by the wrapper itself
5. queryable active runs plus graceful cancellation

## Default decision

Use this skill when the user wants a coding agent to work in the background on a real project.

Prefer this skill over direct PTY orchestration when:
- the task is larger than a tiny edit
- the user wants Codex or Claude Code to do the implementation
- you want a clear run id and artifact trail
- you want a completion notification when the agent finishes

Do not use this skill when:
- the change is a tiny direct edit you can safely do yourself
- the user only wants code reading or explanation
- the user explicitly wants ACP harness sessions in chat/thread form; use `sessions_spawn(runtime:"acp")` for that
- the requested workdir is `~/.openclaw`, `~/.openclaw/workspace`, or another OpenClaw system/config area

## Required inputs

Before launching, make sure you know:
- **agent**: `codex` or `claude`
- **workdir**: real project directory, usually under `~/projects`
- **task**: concrete implementation goal

If the user does not specify the agent:
- default to **codex** for implementation work
- use **claude** only when the user asks for it or when you have a specific reason

## Execution workflow

### 1. Validate the target directory

- Confirm the directory exists
- Prefer project directories under `~/projects`
- Refuse to launch in OpenClaw's own workspace/config area unless the user explicitly asks and understands the risk
- If the repository has its own `AGENTS.md`, read it before launching the coding task

### 2. Choose notification inputs

At launch time, make sure the wrapper has enough information to notify the user when the run starts, progresses, or finishes.

Recommended inputs:
- in **Telegram / Discord / WhatsApp / other message-channel contexts**, pass explicit provider delivery info when available:
  - `--notify-channel`
  - `--notify-target`
  - `--notify-account`
- if the source message provides a reply anchor, pass `--notify-reply-to` so completion messages can stay attached to the triggering message when supported
- if a current OpenClaw session key is available, also pass `--notify-session-key`
- for default routing, prefer configuring `NOTIFY_*` values in `openclaw.json -> skills.entries.coding-assistant.env`
- do not hardcode bot tokens, Telegram ids, or account ids in the skill itself; keep them in OpenClaw config

### 3. Shape the task prompt

Give the coding agent a concrete, bounded task.

Include when useful:
- scope limits (which package/folder to touch)
- validation commands to run
- explicit non-goals
- request to write a concise completion summary into `agent-summary.txt`
- request to populate the structured `agent-report.json` fields clearly

Good prompt shape:
- what to change
- what not to change
- how to verify
- what summary to leave behind

### 3.1 Prefer `docs/dev-plan/` for complex tasks

If the task is too complex to explain cleanly in just a few chat sentences or a short CLI argument, prefer writing a dedicated development plan document inside the **target project** first.

Recommended pattern:
- create `docs/dev-plan/` in the target repository when it does not exist
- add a task-specific plan file such as `docs/dev-plan/2026-03-11-notify-routing-fix.md`
- put the full scope, constraints, validation plan, and completion contract into that file
- launch the coding agent with a **short prompt** that tells it to read that document first and then execute it

Why this is the default for larger tasks:
- avoids overly long CLI `--task` strings
- reduces shell quoting / escaping risk
- makes the task easier to resume later
- leaves a human-reviewable plan inside the project during active work

Important repo hygiene note:
- `docs/dev-plan/` is for active task planning, not long-term product docs
- if the repository should not keep these plan files, add `docs/dev-plan/` to `.gitignore`
- do not assume every project wants these files committed; follow repo conventions or the user's request

### 4. Resume behavior

By default, prefer resuming the latest conversation for the same `agent + workdir`.

- `codex` uses `codex exec resume <sessionId> <prompt>` when a stored session id exists
- `claude` uses `claude -p -r <sessionId> <prompt>` when a stored session id exists
- if no stored session id exists, start a fresh session normally
- if the user explicitly asks for a fresh conversation, pass `--new-session`

### 5. Decide progress notification policy

Do **not** enable progress notifications for every coding task by default, but treat **medium and larger background coding tasks** as progress-worthy by default.

Use this policy:
- **tiny / short / obviously bounded tasks**: do not pass progress flags
- **medium or larger tasks** (for example: multi-file implementation, design + code + docs + validation, unclear debugging loops, refactors, or anything that is not realistically a quick one-shot change): enable wrapper-controlled progress notifications by default
- **if the user explicitly says progress is unnecessary**: skip progress even for a medium/large task

When enabling progress notifications, use these conservative defaults unless the user requested something else:
- `--progress-start-after-seconds 120`
- `--progress-every-seconds 180`

If the user explicitly requests a different cadence, follow the user's requested timing instead.

Important boundary:
- the wrapper controls **when** progress messages are sent
- Codex / Claude control the task execution itself
- do not let the coding agent implicitly decide the notification cadence

### 6. Launch through the wrapper

This skill now lives inside the `coding-agent-wrapper` repository itself.
Treat the wrapper repo root as the skill's parent project directory and prefer running the CLI from that repo root.

Use the compiled wrapper from the repo root:
- repo root: parent project directory of this skill
- CLI: `dist/cli.js`

Typical pattern (with workdir set to the wrapper repo root):

```bash
node dist/cli.js run \
  --agent codex \
  --cwd /path/to/project \
  --label short-task-name \
  --task "...full task prompt..." \
  --notify-channel telegram \
  --notify-target <chat-or-user-id> \
  --notify-account <account-if-needed> \
  --notify-reply-to <replyTo-if-available> \
  --notify-session-key <sessionKey-if-available> \
  --detach
```

If the current channel needs explicit provider delivery and no wrapper defaults are configured yet, add the needed `--notify-channel / --notify-target / --notify-account` flags at launch time. If a current session key is also available, pass `--notify-session-key` too.

Notes:
- `--detach` is the default for long coding work
- use a short readable `--label`
- always prefer the wrapper over manually juggling PTY + process sessions when this skill applies
- do not inline complex multi-line `--task` text directly into a shell command string when launching via `exec`; prompts containing shell-significant characters can be corrupted before reaching the wrapper
- for non-trivial task text, prefer a launch path that bypasses shell interpolation and preserves arguments exactly; reserve direct shell inlining for short/simple task strings only

### 7. Tell the user the run started

After launching, immediately tell the user:
- which agent is running
- which project it is working in
- the `runId`
- what the task is at a high level

Do not spam progress updates. Only send another update when:
- the agent finishes
- the agent is stuck or needs input
- validation failed in an important way
- you decide to stop the task

### 8. If the user asks to stop the task

When the user says things like “stop this”, “cancel this task”, “kill that run”, or otherwise asks to stop an active wrapper run:

- prefer the wrapper's formal stop path (do not treat this as an abnormal crash)
- if the target run is ambiguous, first inspect active runs with `runs` / `show --run-id`
- stop the run by `runId` when possible
- after stopping, report whether the run ended as `cancelled`, whether stop required escalation, and where the artifacts are

Important post-stop rule for source-controlled projects:
- if the project uses git, check whether the working tree now contains source changes from this interrupted run
- do **not** silently discard those files
- explicitly ask the user whether to keep or discard the current modifications
- only after the user answers should you decide the next action (keep as-is, revert selected files, or clean the worktree)

Treat interrupted-but-written work as user-controlled output, not disposable temp data.

### 9. Inspect artifacts when needed

The wrapper writes:

```text
runs/<runId>/run.log
runs/<runId>/result.json
runs/<runId>/status.json
runs/<runId>/agent-summary.txt
runs/<runId>/agent-report.json
```

Use them like this:
- `run.log`: full raw execution log
- `result.json`: structured final result, timestamps, summary, modified files
- `status.json`: running-state snapshot used for in-progress reporting
- `agent-summary.txt`: human-friendly summary left by the coding agent when available
- `agent-report.json`: structured report emitted by the coding agent when available

When the user asks "is it still running?", check `status.json` and `result.json` first, then tail `run.log` if needed.

## Result contract

Expect `result.json` to be the main machine-readable artifact.

Important fields to use in your user-facing summaries:
- `startedAt`
- `finishedAt`
- `durationMinutes`
- `status`
- `exitCode`
- `agentSummary`
- `validationSummary`
- `validation`
- `notes`
- `commitId`
- `sessionId`
- `resumedFromSessionId`
- `modifiedFiles`
- `projectModifiedFiles`
- `artifactFiles`
- `logPath`
- `resultPath`
- `statusPath`
- `summaryPath`
- `reportPath`

When reporting completion yourself, prefer these fields over guessing from raw logs.

## Completion message expectations

The wrapper's completion notification should include key task facts such as:
- start time
- finish time
- duration
- exit status / exit code
- agent summary
- modified files preview
- artifact paths

If the wrapper notifies successfully, do not resend the same information unless the user asks for a fuller summary.

## Fallback behavior

If the wrapper is unavailable or broken:
1. say so briefly
2. fall back to the older direct agent orchestration approach only if necessary
3. keep the user informed that this is degraded mode

If a direct background agent is used as fallback:
- still record the background session id
- still monitor with `process.log` / `process.poll`
- still summarize changed files and status when done

## References

- Read `references/usage-patterns.md` for ready-to-use launch templates and reporting patterns.
