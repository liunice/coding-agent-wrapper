# Coding Assistant Usage Patterns

## Launch template: Telegram / message channel

Use when the current conversation is a real messaging channel.
Prefer wrapper defaults from `openclaw.json -> skills.entries.coding-assistant.env` via `NOTIFY_*`.
Only pass explicit routing flags when the defaults are unavailable or you need to override them.

Short/normal task without in-progress notifications:

```bash
# run from the coding-agent-wrapper repo root
node dist/cli.js run \
  --agent codex \
  --cwd /path/to/project \
  --label short-label \
  --task "Implement X. Validate with Y. Write a concise completion summary to agent-summary.txt." \
  --notify-session-key <session-key-if-available> \
  --detach
```

Clearly long-running task with wrapper-controlled progress cadence:

```bash
# run from the coding-agent-wrapper repo root
node dist/cli.js run \
  --agent codex \
  --cwd /path/to/project \
  --label short-label \
  --task "Implement X. Validate with Y. Write a concise completion summary to agent-summary.txt." \
  --notify-session-key <session-key-if-available> \
  --progress-start-after-seconds 120 \
  --progress-every-seconds 180 \
  --detach
```

Add `--new-session` only when the user explicitly wants to avoid resuming the latest stored conversation for that agent/workdir.

## Launch template: session-only / webchat

Use when you only want the result to come back to the current session.

```bash
# run from the coding-agent-wrapper repo root
node dist/cli.js run \
  --agent codex \
  --cwd /path/to/project \
  --label short-label \
  --task "Implement X. Validate with Y. Write a concise completion summary to agent-summary.txt." \
  --notify-session-key main \
  --detach
```

If the task is clearly long-running and the user wants in-progress updates, add:

```bash
  --progress-start-after-seconds 120 \
  --progress-every-seconds 180 \
```

## Prompt pattern: bounded implementation task

```text
You are working in repository <path>.

Scope:
- Only touch <package/folder>
- Avoid unrelated refactors

Goal:
- <concrete implementation target>

Validation:
- Run: <command 1>
- Run: <command 2>

Deliverable:
- Write a concise human summary into agent-summary.txt
- Write a structured agent-report.json with: taskSummary, modifiedFiles, projectModifiedFiles, artifactFiles, validation, validationSummary, notes, commitId
- If it is a git repo and the work is successfully completed + checked, commit the work and return the new commit id; otherwise set commitId to null
```

## What to tell the user at launch

Keep it short:
- which agent
- which project
- what high-level task
- runId

Example:

```text
已启动，Codex 正在 /path/to/project 里处理 exports 校验。
runId: 20260309071621-real-bma-exports-check
跑完会自动发完成通知。
```

## What to tell the user after completion

Prefer the wrapper artifact fields over hand-written guesses.

Checklist:
- status / exit code
- startedAt / finishedAt / durationMinutes
- sessionId / resumedFromSessionId
- agentSummary
- modifiedFiles
- artifact paths when useful

Example:

```text
任务完成，exit 0。
开始：...
完成：...
耗时：...
修改文件：a.ts, b.ts
摘要：...
```

## Stop / cancel pattern

When the user asks to stop an active wrapper run, prefer the wrapper's formal stop path:

```bash
# run from the coding-agent-wrapper repo root
node dist/cli.js stop \
  --run-id <runId>
```

Before stopping, if the target run is ambiguous, first use the wrapper query commands to identify it:

```bash
# run from the coding-agent-wrapper repo root
node dist/cli.js runs
node dist/cli.js show --run-id <runId>
```

After the stop completes:
- report whether the run ended as `cancelled`
- mention whether artifacts/logs were preserved
- if the project is a git repo, inspect the worktree for modifications left by the interrupted run
- tell the user which files are currently modified
- ask the user whether to keep those changes or discard/revert them
- do not silently remove modified source files without user confirmation

Minimal git checks after interruption:

```bash
git status --short
git diff --stat
```

## Safety notes

- Do not launch coding assistant inside `~/.openclaw` unless explicitly requested
- Do not let the task sprawl across the entire repo when the user asked for a small scoped fix
- Prefer Codex by default for implementation work in this environment
- If the repo has local instructions (`AGENTS.md`), read them before launching
