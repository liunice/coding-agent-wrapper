/**
 * Implements run lifecycle management, logging, result artifacts, and notifications.
 * Important note: detached execution reuses the same CLI with an internal flag.
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { writeAgentActivity } from "./activity";
import { createAgentLaunchSpec } from "./adapters";
import {
  consumeClaudeStreamChunk,
  createClaudeStreamState,
} from "./claude-stream";
import { startProgressMonitor } from "./monitor";
import { sendCompletionNotification } from "./reporter";
import {
  createSessionDetectionState,
  detectSessionIdFromStream,
  extractSessionId,
} from "./session-id";
import { saveResumeSessionId } from "./sessions";
import {
  acquireActiveRunClaim,
  adoptActiveRunClaim,
  getRunRuntimeState,
  releaseActiveRunClaim,
  transferActiveRunClaim,
} from "./single-flight";
import { initializeRunStatus, patchRunStatus } from "./status";
import type {
  AgentReport,
  RepoSnapshot,
  RunCliOptions,
  RunContext,
  RunResult,
  RunRuntimeState,
  RunStatus,
} from "./types";

/** Limits how much stdout/stderr is kept in memory for summary extraction. */
const MAX_CAPTURED_OUTPUT = 256 * 1024;

/** Limits how often Claude agent activity is flushed to disk during streaming. */
const CLAUDE_ACTIVITY_FLUSH_INTERVAL_MS = 2000;

/** Creates or resolves all filesystem paths needed for a single run. */
export async function createRunContext(
  options: RunCliOptions,
): Promise<RunContext> {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const runId =
    options.runId ?? buildRunId(options.agent, options.label, startedAt);
  const runDir = path.resolve(options.outputRoot, runId);
  const logPath = path.join(runDir, "run.log");
  const agentActivityPath = path.join(runDir, "agent-activity.json");
  const resultPath = path.join(runDir, "result.json");
  const statusPath = path.join(runDir, "status.json");
  const summaryPath = path.join(runDir, "agent-summary.txt");
  const reportPath = path.join(runDir, "agent-report.json");

  await mkdir(runDir, { recursive: true });

  return {
    runId,
    runDir,
    logPath,
    agentActivityPath,
    resultPath,
    statusPath,
    summaryPath,
    reportPath,
    startedAt,
    taskSummary: summarizeTask(options.task),
    repoSnapshot: await captureRepoSnapshot(options.cwd),
  };
}

/** Starts a detached child that continues the real run in the background. */
export async function launchDetached(
  options: RunCliOptions,
  context: RunContext,
): Promise<void> {
  const claim = await acquireActiveRunClaim(
    options.outputRoot,
    options.agent,
    options.cwd,
    context,
  );

  try {
    await initializeRunStatus(
      options,
      context,
      getRunRuntimeState(claim),
      "Detached run started.",
    );
    await writeResultFile(
      options,
      context,
      "running",
      null,
      null,
      "Detached run started.",
      null,
      null,
      getRunRuntimeState(claim),
    );

    const cliPath = path.resolve(process.argv[1]);
    const args = [
      cliPath,
      "run",
      "--internal-run",
      "--agent",
      options.agent,
      "--cwd",
      options.cwd,
      "--task",
      options.task,
      "--output-root",
      options.outputRoot,
      "--run-id",
      context.runId,
      "--started-at",
      context.startedAt,
    ];

    if (options.resumeMode === "never") {
      args.push("--new-session");
    }

    if (options.label) {
      args.push("--label", options.label);
    }
    if (options.progressEverySeconds) {
      args.push(
        "--progress-every-seconds",
        String(options.progressEverySeconds),
      );
    }
    if (options.progressStartAfterSeconds !== undefined) {
      args.push(
        "--progress-start-after-seconds",
        String(options.progressStartAfterSeconds),
      );
    }

    if (options.notifySessionKey) {
      args.push("--notify-session-key", options.notifySessionKey);
    }
    if (options.notifyChannel) {
      args.push("--notify-channel", options.notifyChannel);
    }
    if (options.notifyTarget) {
      args.push("--notify-target", options.notifyTarget);
    }
    if (options.notifyAccount) {
      args.push("--notify-account", options.notifyAccount);
    }
    if (options.notifyReplyTo) {
      args.push("--notify-reply-to", options.notifyReplyTo);
    }
    if (options.notifyThreadId) {
      args.push("--notify-thread-id", options.notifyThreadId);
    }

    if (options.passthroughArgs.length > 0) {
      args.push("--", ...options.passthroughArgs);
    }

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });

    if (!child.pid) {
      throw new Error("Failed to determine detached wrapper pid.");
    }

    await transferActiveRunClaim(claim, child.pid);
    await patchRunStatus(options, context, {
      phase: "queued",
      summary: "Detached run started.",
      runtimeState: getRunRuntimeState(claim),
    });
    await writeResultFile(
      options,
      context,
      "running",
      null,
      null,
      "Detached run started.",
      null,
      null,
      getRunRuntimeState(claim),
    );

    child.unref();
  } catch (error) {
    await releaseActiveRunClaim(claim);
    throw error;
  }
}

/** Executes one agent run and returns the final process exit code. */
export async function executeRun(
  options: RunCliOptions,
  context: RunContext,
): Promise<number> {
  const claim = options.internalRun
    ? await adoptActiveRunClaim(
        options.outputRoot,
        options.agent,
        options.cwd,
        context,
      )
    : await acquireActiveRunClaim(
        options.outputRoot,
        options.agent,
        options.cwd,
        context,
      );

  let logStream: ReturnType<typeof createWriteStream> | null = null;
  const progressMonitor = startProgressMonitor(options, context, (line) => {
    logStream?.write(`${line}\n`);
  });

  try {
    await initializeRunStatus(
      options,
      context,
      getRunRuntimeState(claim),
      "Run started.",
    );
    await writeResultFile(
      options,
      context,
      "running",
      null,
      null,
      "Run started.",
      null,
      null,
      getRunRuntimeState(claim),
    );

    const spec = await createAgentLaunchSpec(options, context);
    logStream = createWriteStream(context.logPath, { flags: "a" });
    const activeLogStream = logStream;

    try {
      activeLogStream.write(
        buildLogHeader(options, context, spec.command, spec.args),
      );

      const child = spawn(spec.command, spec.args, {
        cwd: options.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let cancellationRequested = false;
      let cancellationFinished = false;
      let cancellationSignalSent = false;
      const requestCancellation = (): void => {
        if (cancellationRequested) {
          return;
        }
        cancellationRequested = true;
        activeLogStream.write(
          "\n[wrapper] cancellation requested; sending SIGTERM to child\n",
        );
        void patchRunStatus(options, context, {
          phase: "running",
          summary: "Stop requested by user; attempting graceful shutdown.",
          stopRequestedAt: new Date().toISOString(),
          stopRequestedBy: "user",
        });
        if (!cancellationSignalSent && child.pid) {
          cancellationSignalSent = true;
          try {
            process.kill(child.pid, "SIGTERM");
          } catch {
            // ignore missing child
          }
          setTimeout(() => {
            if (cancellationFinished || !child.pid) {
              return;
            }
            try {
              process.kill(child.pid, "SIGKILL");
              activeLogStream.write(
                "[wrapper] graceful shutdown timed out; sent SIGKILL to child\n",
              );
            } catch {
              // ignore missing child
            }
          }, 8000).unref();
        }
      };

      const handleTerminationSignal = (): void => {
        requestCancellation();
      };
      process.once("SIGTERM", handleTerminationSignal);
      process.once("SIGINT", handleTerminationSignal);

      await patchRunStatus(options, context, {
        phase: "starting",
        summary: "Launching coding agent process.",
        resumedFromSessionId: spec.resumedSessionId ?? null,
      });

      let capturedStdout = "";
      let capturedStderr = "";
      const sessionDetection = createSessionDetectionState();
      const claudeStreamState =
        options.agent === "claude" ? createClaudeStreamState() : null;

      let lastPersistedSessionId: string | null = null;
      let lastStatusHeartbeatAt = Date.now();
      let lastActivityFlushAtMs = 0;
      let lastPersistedActivityAt: string | null = null;
      let lastPersistedActivitySummary: string | null = null;
      let activityWriteChain = Promise.resolve();

      const flushClaudeActivity = (force = false): void => {
        if (!claudeStreamState?.latestActivityAt) {
          return;
        }

        const summary = claudeStreamState.latestActivitySummary ?? null;
        const activityChanged =
          claudeStreamState.latestActivityAt !== lastPersistedActivityAt;
        const summaryChanged = summary !== lastPersistedActivitySummary;
        const flushDue =
          Date.now() - lastActivityFlushAtMs >=
          CLAUDE_ACTIVITY_FLUSH_INTERVAL_MS;

        if (!force && !summaryChanged && !activityChanged) {
          return;
        }

        if (!force && !summaryChanged && !flushDue) {
          return;
        }

        lastActivityFlushAtMs = Date.now();
        lastPersistedActivityAt = claudeStreamState.latestActivityAt;
        lastPersistedActivitySummary = summary;
        activityWriteChain = activityWriteChain
          .catch(() => undefined)
          .then(
            async () =>
              await writeAgentActivity(context.agentActivityPath, {
                updatedAt:
                  claudeStreamState.latestActivityAt ??
                  new Date().toISOString(),
                summary,
              }),
          )
          .catch(() => undefined);
      };

      const handleChildText = (
        streamName: "stdout" | "stderr",
        text: string,
      ): void => {
        if (streamName === "stdout") {
          capturedStdout = appendCapturedText(capturedStdout, text);
        } else {
          capturedStderr = appendCapturedText(capturedStderr, text);
        }

        detectSessionIdFromStream(options.agent, sessionDetection, text);
        if (streamName === "stdout" && claudeStreamState) {
          const claudeChunk = consumeClaudeStreamChunk(
            claudeStreamState,
            text,
            options.cwd,
          );
          if (claudeChunk.sawActivity) {
            flushClaudeActivity();
          }
        }
        activeLogStream.write(text);

        const detectedSessionId =
          sessionDetection.sessionId ?? claudeStreamState?.sessionId ?? null;
        if (detectedSessionId && detectedSessionId !== lastPersistedSessionId) {
          lastPersistedSessionId = detectedSessionId;
          void patchRunStatus(options, context, {
            phase: "running",
            summary: "Agent session established; task is running.",
            sessionId: detectedSessionId,
          });
        } else if (Date.now() - lastStatusHeartbeatAt >= 15000) {
          lastStatusHeartbeatAt = Date.now();
          void patchRunStatus(options, context, {
            phase: "running",
            summary: "Agent is still running.",
          });
        }

        if (options.internalRun) {
          return;
        }

        if (streamName === "stdout") {
          process.stdout.write(text);
          return;
        }

        process.stderr.write(text);
      };

      await patchRunStatus(options, context, {
        phase: "running",
        summary: "Agent process started; waiting for progress output.",
        runtimeState: {
          pid: getRunRuntimeState(claim).pid,
          childPid: child.pid ?? null,
          claimedAt: getRunRuntimeState(claim).claimedAt,
          terminationReason: getRunRuntimeState(claim).terminationReason,
        },
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        handleChildText("stdout", chunk.toString());
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        handleChildText("stderr", chunk.toString());
      });

      const exitCode = await new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 1));
        child.on("error", (error) => {
          activeLogStream.write(
            `\n[wrapper] Failed to spawn child process: ${error.message}\n`,
          );
          resolve(1);
        });
      });

      cancellationFinished = true;
      process.removeListener("SIGTERM", handleTerminationSignal);
      process.removeListener("SIGINT", handleTerminationSignal);

      if (claudeStreamState?.pendingLine.trim()) {
        consumeClaudeStreamChunk(claudeStreamState, "\n", options.cwd);
      }
      flushClaudeActivity(true);
      await activityWriteChain;

      const status: RunStatus = cancellationRequested
        ? "cancelled"
        : exitCode === 0
          ? "success"
          : "failed";
      let sessionId =
        sessionDetection.sessionId ?? claudeStreamState?.sessionId ?? null;

      if (!sessionId) {
        sessionId = await extractSessionIdFromRunLog(
          options.agent,
          context.logPath,
          activeLogStream,
        );
      }

      if (sessionId) {
        await saveResumeSessionId(
          options.outputRoot,
          options.agent,
          options.cwd,
          sessionId,
        );
        activeLogStream.write(`[wrapper] sessionId=${sessionId}\n`);
        await patchRunStatus(options, context, {
          phase: "running",
          summary: "Captured agent session id.",
          sessionId,
        });
      }

      await patchRunStatus(options, context, {
        phase: cancellationRequested ? "cancelled" : "summarizing",
        summary: cancellationRequested
          ? "Run cancelled by user; building final cancellation artifacts."
          : "Agent process finished; building summary and result artifacts.",
        sessionId,
      });

      const summary = cancellationRequested
        ? "Run cancelled by user during execution."
        : await buildSummary(
            context,
            capturedStdout,
            capturedStderr,
            exitCode,
            claudeStreamState?.finalResultText ?? null,
          );

      const finishedAt = new Date().toISOString();
      const finalRuntimeState = {
        ...getRunRuntimeState(claim, buildTerminationReason(status, exitCode)),
        childPid: child.pid ?? null,
      };

      await writeResultFile(
        options,
        context,
        status,
        exitCode,
        finishedAt,
        summary,
        sessionId,
        spec.resumedSessionId ?? null,
        finalRuntimeState,
      );
      await patchRunStatus(options, context, {
        finishedAt,
        phase:
          status === "success"
            ? "completed"
            : status === "cancelled"
              ? "cancelled"
              : "failed",
        summary,
        status,
        resultState:
          status === "success"
            ? "success"
            : status === "cancelled"
              ? "cancelled"
              : "failed",
        sessionId,
        resumedFromSessionId: spec.resumedSessionId ?? null,
        stopRequestedAt: cancellationRequested
          ? new Date().toISOString()
          : undefined,
        stopRequestedBy: cancellationRequested ? "user" : undefined,
        runtimeState: finalRuntimeState,
      });
      await sendCompletionNotification(
        options,
        await buildNotificationText(options, context, status, exitCode),
        (line) => activeLogStream.write(`${line}\n`),
      );

      return exitCode;
    } finally {
      if (logStream) {
        await closeLogStream(logStream);
      }
    }
  } finally {
    progressMonitor.stop();
    await releaseActiveRunClaim(claim);
  }
}

/** Writes the JSON artifact consumed by humans or higher-level tooling. */
export async function writeResultFile(
  options: RunCliOptions,
  context: RunContext,
  status: RunStatus,
  exitCode: number | null,
  finishedAt: string | null,
  summary: string,
  sessionId: string | null = null,
  resumedFromSessionId: string | null = null,
  runtimeState: RunRuntimeState = {
    pid: null,
    claimedAt: null,
    terminationReason: null,
  },
): Promise<void> {
  const agentSummary = await readOptionalText(context.summaryPath);
  const report = await readAgentReport(context.reportPath);
  const detectedModifiedFiles = await collectModifiedFiles(
    context.repoSnapshot,
  );
  const artifactFiles =
    normalizeStringList(report?.artifactFiles) ??
    detectArtifactFiles(normalizeStringList(report?.modifiedFiles) ?? []);
  const explicitProjectModifiedFiles = normalizeStringList(
    report?.projectModifiedFiles,
  );
  const fallbackModifiedFiles = excludeArtifactFiles(
    detectedModifiedFiles,
    artifactFiles,
  );
  const projectModifiedFiles =
    explicitProjectModifiedFiles ??
    excludeArtifactFiles(
      normalizeStringList(report?.modifiedFiles) ?? fallbackModifiedFiles,
      artifactFiles,
    );
  const validation = normalizeStringList(report?.validation) ?? [];

  const payload: RunResult = {
    runId: context.runId,
    agent: options.agent,
    cwd: options.cwd,
    label: options.label,
    taskSummary: context.taskSummary,
    startedAt: context.startedAt,
    finishedAt,
    durationMinutes: calculateDurationMinutes(context.startedAt, finishedAt),
    exitCode,
    status,
    logPath: context.logPath,
    resultPath: context.resultPath,
    statusPath: context.statusPath,
    summaryPath: context.summaryPath,
    reportPath: context.reportPath,
    summary,
    agentSummary: trimSummary(report?.taskSummary ?? agentSummary ?? summary),
    validation,
    validationSummary: normalizeOptionalString(report?.validationSummary),
    notes: normalizeOptionalString(report?.notes),
    commitId: normalizeOptionalString(report?.commitId),
    sessionId,
    resumedFromSessionId,
    pid: runtimeState.pid,
    childPid: runtimeState.childPid ?? null,
    claimedAt: runtimeState.claimedAt,
    terminationReason: runtimeState.terminationReason,
    modifiedFiles: projectModifiedFiles,
    projectModifiedFiles,
    artifactFiles,
  };

  await writeFile(
    context.resultPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

/** Produces a compact notification line for downstream delivery. */
async function buildNotificationText(
  options: RunCliOptions,
  context: RunContext,
  status: RunStatus,
  exitCode: number,
): Promise<string> {
  const name = options.label ?? context.runId;
  const result = await readRunResult(context.resultPath);
  const modifiedLines = formatModifiedFileLines(
    result?.projectModifiedFiles ?? [],
  );
  const agentSummary = result?.agentSummary ?? "";
  const validationSummary =
    result?.validationSummary ??
    formatValidationSummary(result?.validation ?? []);

  const title =
    status === "cancelled"
      ? `后台任务已停止：${name}`
      : `后台任务已完成：${name}`;

  const statusLine =
    status === "cancelled"
      ? "• 状态: cancelled (user stop)"
      : `• 状态: ${status} (exit ${exitCode})`;

  return [
    title,
    "",
    "**【任务信息】**",
    `• Agent: ${options.agent}`,
    statusLine,
    `• Run ID: ${context.runId}`,
    `• 目录: ${options.cwd}`,
    "",
    "**【时间】**",
    `• 开始: ${formatDisplayTime(context.startedAt)}`,
    `• 完成: ${formatDisplayTime(result?.finishedAt ?? null)}`,
    `• 耗时(分钟): ${result?.durationMinutes ?? "unknown"}`,
    "",
    "**【任务目标】**",
    `• ${context.taskSummary}`,
    "",
    "**【任务总结】**",
    `• ${agentSummary || "(none)"}`,
    "",
    "**【会话 / 验证 / 提交】**",
    `• 验证: ${validationSummary || "(未提供)"}`,
    `• Session ID: ${result?.sessionId ?? "unknown"}`,
    `• Resume 来源: ${result?.resumedFromSessionId ?? "(new session)"}`,
    `• Commit ID: ${result?.commitId ?? "(none)"}`,
    "",
    "**【修改文件】**",
    ...modifiedLines,
    "",
    "**【备注】**",
    `• ${result?.notes ?? "(none)"}`,
    "",
    "**【产物】**",
    `• 结果文件: ${formatRunArtifactPath(context.runId, context.resultPath)}`,
    `• 日志文件: ${formatRunArtifactPath(context.runId, context.logPath)}`,
  ].join("\n");
}

/** Reads the best available summary source after the child process exits. */
async function buildSummary(
  context: RunContext,
  capturedStdout: string,
  capturedStderr: string,
  exitCode: number,
  explicitAgentSummary: string | null = null,
): Promise<string> {
  const fileSummary = await readOptionalText(context.summaryPath);
  if (fileSummary) {
    return trimSummary(fileSummary);
  }

  const claudeSummary =
    explicitAgentSummary ?? extractClaudeSummary(capturedStdout);
  if (claudeSummary) {
    return trimSummary(claudeSummary);
  }

  const combined = [capturedStdout, capturedStderr].filter(Boolean).join("\n");
  if (combined.trim()) {
    return trimSummary(combined);
  }

  return exitCode === 0
    ? "Completed without summary output."
    : "Failed without summary output.";
}

/** Attempts to parse Claude Code JSON output into a short summary string. */
function extractClaudeSummary(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  const streamJsonSummary = extractClaudeStreamJsonSummary(trimmed);
  if (streamJsonSummary) {
    return streamJsonSummary;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    if (typeof parsed.result === "string") {
      return parsed.result;
    }

    if (typeof parsed.content === "string") {
      return parsed.content;
    }

    if (Array.isArray(parsed.content)) {
      const text = parsed.content
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }
          if (
            item &&
            typeof item === "object" &&
            "text" in item &&
            typeof item.text === "string"
          ) {
            return item.text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");

      return text || null;
    }
  } catch {
    return null;
  }

  return null;
}

function extractClaudeStreamJsonSummary(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as {
        type?: unknown;
        result?: unknown;
      };
      if (parsed.type === "result" && typeof parsed.result === "string") {
        return parsed.result;
      }
    } catch {
      // Ignore malformed lines while scanning NDJSON output.
    }
  }

  return null;
}

/** Builds a readable log file prelude for each run. */
function buildLogHeader(
  options: RunCliOptions,
  context: RunContext,
  command: string,
  args: string[],
): string {
  return [
    `[wrapper] runId=${context.runId}`,
    `[wrapper] agent=${options.agent}`,
    `[wrapper] cwd=${options.cwd}`,
    `[wrapper] startedAt=${context.startedAt}`,
    `[wrapper] command=${renderCommand(command, args)}`,
    `[wrapper] taskSummary=${context.taskSummary}`,
    "",
  ].join("\n");
}

/** Renders a shell-like command string for logs and debugging. */
function renderCommand(command: string, args: string[]): string {
  return [command, ...args.map(quoteArgument)].join(" ");
}

/** Applies simple shell-safe quoting for human-readable logs. */
function quoteArgument(value: string): string {
  return /[^A-Za-z0-9_./:-]/.test(value) ? JSON.stringify(value) : value;
}

/** Generates a stable run identifier with timestamp and optional label. */
function buildRunId(
  agent: string,
  label: string | undefined,
  startedAt: string,
): string {
  const timestamp = formatRunIdTimestamp(startedAt);
  const name = sanitizeSegment(label ?? agent);
  return `${timestamp}-${name}`;
}

function formatRunIdTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.replace(/[^0-9]/g, "").slice(0, 14) || "run";
  }

  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

/** Converts a free-form label into a filesystem-safe segment. */
function sanitizeSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "run"
  );
}

/** Produces a short one-line task summary for result files and notifications. */
function summarizeTask(task: string): string {
  const compact = task.replace(/\s+/g, " ").trim();
  if (compact.length <= 140) {
    return compact;
  }
  return `${compact.slice(0, 137)}...`;
}

/** Keeps only the most recent output chunk within the in-memory capture limit. */
function appendCapturedText(current: string, next: string): string {
  const merged = `${current}${next}`;
  if (merged.length <= MAX_CAPTURED_OUTPUT) {
    return merged;
  }
  return merged.slice(-MAX_CAPTURED_OUTPUT);
}

/**
 * Flushes child output to disk and scans the full run log when stream-time
 * detection did not find a session id.
 */
async function extractSessionIdFromRunLog(
  agent: RunCliOptions["agent"],
  logPath: string,
  logStream: ReturnType<typeof createWriteStream>,
): Promise<string | null> {
  await flushLogStream(logStream);
  const fullLog = await readOptionalText(logPath);
  return fullLog ? extractSessionId(agent, fullLog) : null;
}

/** Reads a UTF-8 text file if it exists, otherwise returns null. */
async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readRunResult(filePath: string): Promise<RunResult | null> {
  const content = await readOptionalText(filePath);
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content) as RunResult;
  } catch {
    return null;
  }
}

async function readAgentReport(filePath: string): Promise<AgentReport | null> {
  const content = await readOptionalText(filePath);
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content) as AgentReport;
  } catch {
    return null;
  }
}

async function captureRepoSnapshot(cwd: string): Promise<RepoSnapshot | null> {
  const rootDir = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!rootDir) {
    return null;
  }

  const headCommit = await runGit(["rev-parse", "HEAD"], cwd);
  const changedRaw = await runGit(["status", "--porcelain"], cwd);
  const changedEntries = parseGitStatus(changedRaw ?? "");

  return {
    rootDir,
    headCommit,
    changedEntries,
  };
}

async function collectModifiedFiles(
  snapshot: RepoSnapshot | null,
): Promise<string[]> {
  if (!snapshot) {
    return [];
  }

  const changedRaw = await runGit(["status", "--porcelain"], snapshot.rootDir);
  const currentEntries = parseGitStatus(changedRaw ?? "");
  const paths = new Set<string>();

  for (const path of Object.keys(snapshot.changedEntries)) {
    if (!(path in currentEntries)) {
      continue;
    }

    if (currentEntries[path] !== snapshot.changedEntries[path]) {
      paths.add(path);
    }
  }

  for (const [path, status] of Object.entries(currentEntries)) {
    if (!(path in snapshot.changedEntries) && status.trim()) {
      paths.add(path);
    }
  }

  return Array.from(paths).sort();
}

function parseGitStatus(output: string): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const status = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const path = rawPath.includes(" -> ")
      ? (rawPath.split(" -> ").at(-1) ?? rawPath)
      : rawPath;
    entries[path] = status;
  }

  return entries;
}

function calculateDurationSeconds(
  startedAt: string,
  finishedAt: string | null,
): number | null {
  if (!finishedAt) {
    return null;
  }

  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(finishedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }

  return Math.round((endMs - startMs) / 1000);
}

function calculateDurationMinutes(
  startedAt: string,
  finishedAt: string | null,
): number | null {
  const seconds = calculateDurationSeconds(startedAt, finishedAt);
  if (seconds === null) {
    return null;
  }
  return Number((seconds / 60).toFixed(1));
}

/** Maps the final wrapper status into a compact result termination reason. */
function buildTerminationReason(
  status: RunStatus,
  exitCode: number | null,
): string | null {
  if (status === "running") {
    return null;
  }

  if (status === "success") {
    return "completed";
  }

  if (status === "cancelled") {
    return "user_cancelled";
  }

  return typeof exitCode === "number" ? `exit-${exitCode}` : "failed";
}

function formatDisplayTime(value: string | null): string {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} GMT+8`;
}

function formatValidationSummary(validation: string[]): string | null {
  if (validation.length === 0) {
    return null;
  }
  return validation.slice(0, 3).join(", ");
}

function formatRunArtifactPath(runId: string, filePath: string): string {
  const fileName = path.basename(filePath);
  return `runs/${runId}/${fileName}`;
}

function normalizeStringList(
  value: string[] | null | undefined,
): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function detectArtifactFiles(files: string[]): string[] {
  return files.filter((file) =>
    /(^|\/)runs\/[^/]+\/(agent-summary\.txt|agent-report\.json|result\.json|run\.log)$/.test(
      file,
    ),
  );
}

function excludeArtifactFiles(
  files: string[],
  artifactFiles: string[],
): string[] {
  const artifactSet = new Set(artifactFiles);
  return files.filter((file) => !artifactSet.has(file));
}

function formatModifiedFileLines(files: string[]): string[] {
  if (files.length === 0) {
    return ["• (本次未修改项目文件)"];
  }

  const limit = 20;
  const lines = files.slice(0, limit).map((file) => `• ${file}`);
  if (files.length > limit) {
    lines.push(`• ... (+${files.length - limit} more)`);
  }
  return lines;
}

async function runGit(args: string[], cwd: string): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    execFile("git", args, { cwd }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout.trim() || null);
    });
  });
}

/** Shrinks long summaries while keeping the latest useful lines. */
function trimSummary(value: string): string {
  const lines = value
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const recent = lines.slice(-20).join("\n");
  return recent.length <= 4000 ? recent : recent.slice(-4000);
}

/** Closes the log stream after buffered writes are flushed. */
async function closeLogStream(
  logStream: ReturnType<typeof createWriteStream>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    logStream.end(() => resolve());
  });
}

/** Waits until prior writes are flushed so follow-up log reads see full output. */
async function flushLogStream(
  logStream: ReturnType<typeof createWriteStream>,
): Promise<void> {
  if (logStream.destroyed) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    logStream.write("", (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
