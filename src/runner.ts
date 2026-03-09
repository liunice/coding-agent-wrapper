/**
 * Implements run lifecycle management, logging, result artifacts, and notifications.
 * Important note: detached execution reuses the same CLI with an internal flag.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createAgentLaunchSpec } from "./adapters";
import type { CliOptions, RunContext, RunResult, RunStatus } from "./types";

/** Limits how much stdout/stderr is kept in memory for summary extraction. */
const MAX_CAPTURED_OUTPUT = 256 * 1024;

/** Creates or resolves all filesystem paths needed for a single run. */
export async function createRunContext(
  options: CliOptions,
): Promise<RunContext> {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const runId =
    options.runId ?? buildRunId(options.agent, options.label, startedAt);
  const runDir = path.resolve(options.outputRoot, runId);
  const logPath = path.join(runDir, "run.log");
  const resultPath = path.join(runDir, "result.json");
  const summaryPath = path.join(runDir, "agent-summary.txt");

  await mkdir(runDir, { recursive: true });

  return {
    runId,
    runDir,
    logPath,
    resultPath,
    summaryPath,
    startedAt,
    taskSummary: summarizeTask(options.task),
  };
}

/** Starts a detached child that continues the real run in the background. */
export async function launchDetached(
  options: CliOptions,
  context: RunContext,
): Promise<void> {
  await writeResultFile(
    options,
    context,
    "running",
    null,
    null,
    "Detached run started.",
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

  if (options.label) {
    args.push("--label", options.label);
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

  child.unref();
}

/** Executes one agent run and returns the final process exit code. */
export async function executeRun(
  options: CliOptions,
  context: RunContext,
): Promise<number> {
  await writeResultFile(
    options,
    context,
    "running",
    null,
    null,
    "Run started.",
  );

  const spec = createAgentLaunchSpec(options, context);
  const logStream = createWriteStream(context.logPath, { flags: "a" });

  try {
    logStream.write(buildLogHeader(options, context, spec.command, spec.args));

    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let capturedStdout = "";
    let capturedStderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      capturedStdout = appendCapturedText(capturedStdout, text);
      logStream.write(text);
      if (!options.internalRun) {
        process.stdout.write(text);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      capturedStderr = appendCapturedText(capturedStderr, text);
      logStream.write(text);
      if (!options.internalRun) {
        process.stderr.write(text);
      }
    });

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", (error) => {
        logStream.write(
          `\n[wrapper] Failed to spawn child process: ${error.message}\n`,
        );
        resolve(1);
      });
    });

    const status: RunStatus = exitCode === 0 ? "success" : "failed";
    const summary = await buildSummary(
      context,
      capturedStdout,
      capturedStderr,
      exitCode,
    );

    await writeResultFile(
      options,
      context,
      status,
      exitCode,
      new Date().toISOString(),
      summary,
    );
    await notifyCompletion(
      options,
      buildNotificationText(options, context, status, exitCode),
      logStream,
    );

    return exitCode;
  } finally {
    await closeLogStream(logStream);
  }
}

/** Writes the JSON artifact consumed by humans or higher-level tooling. */
export async function writeResultFile(
  options: CliOptions,
  context: RunContext,
  status: RunStatus,
  exitCode: number | null,
  finishedAt: string | null,
  summary: string,
): Promise<void> {
  const payload: RunResult = {
    runId: context.runId,
    agent: options.agent,
    cwd: options.cwd,
    label: options.label,
    taskSummary: context.taskSummary,
    startedAt: context.startedAt,
    finishedAt,
    exitCode,
    status,
    logPath: context.logPath,
    summary,
  };

  await writeFile(
    context.resultPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

/** Produces a compact notification line for downstream delivery. */
function buildNotificationText(
  options: CliOptions,
  context: RunContext,
  status: RunStatus,
  exitCode: number,
): string {
  const name = options.label ?? context.runId;
  return [
    `后台任务已完成：${name}`,
    `- Agent: ${options.agent}`,
    `- 状态: ${status} (exit ${exitCode})`,
    `- 目录: ${options.cwd}`,
    `- Run ID: ${context.runId}`,
    `- 摘要: ${context.taskSummary}`,
    `- 结果文件: ${context.resultPath}`,
    `- 日志文件: ${context.logPath}`,
  ].join("\n");
}

/** Sends the completion notification without failing the main run on errors. */
async function notifyCompletion(
  options: CliOptions,
  text: string,
  logStream: ReturnType<typeof createWriteStream>,
): Promise<void> {
  const openclawPath = resolveOpenClawBinary();
  const command = openclawPath ?? "openclaw";
  const args = buildNotifyArgs(options, text);

  if (!args) {
    logStream.write("[wrapper] notify skipped=no-target\n");
    return;
  }

  logStream.write(
    `[wrapper] notify command=${renderCommand(command, args)}\n`,
  );

  await new Promise<void>((resolve) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      env: process.env,
    });

    child.on("close", (code) => {
      logStream.write(`[wrapper] notify exit=${code ?? "null"}\n`);
      resolve();
    });

    child.on("error", (error) => {
      logStream.write(`[wrapper] notify error=${error.message}\n`);
      resolve();
    });
  });
}

/** Resolves an absolute openclaw binary path when PATH inheritance is unreliable. */
function buildNotifyArgs(options: CliOptions, text: string): string[] | null {
  if (options.notifySessionKey) {
    const params = {
      sessionKey: options.notifySessionKey,
      message: text,
      label: "coding-agent-wrapper",
    };

    return [
      "gateway",
      "call",
      "chat.inject",
      "--params",
      JSON.stringify(params),
      "--timeout",
      "10000",
    ];
  }

  if (options.notifyTarget) {
    const args = [
      "message",
      "send",
      "--target",
      options.notifyTarget,
      "--message",
      text,
    ];

    if (options.notifyChannel) {
      args.push("--channel", options.notifyChannel);
    }
    if (options.notifyAccount) {
      args.push("--account", options.notifyAccount);
    }
    if (options.notifyReplyTo) {
      args.push("--reply-to", options.notifyReplyTo);
    }
    if (options.notifyThreadId) {
      args.push("--thread-id", options.notifyThreadId);
    }

    return args;
  }

  return ["system", "event", "--text", text, "--mode", "now"];
}

function resolveOpenClawBinary(): string | null {
  const candidates = [
    process.env.OPENCLAW_BIN,
    process.env.npm_config_prefix
      ? path.join(process.env.npm_config_prefix, "bin", "openclaw")
      : null,
    process.env.HOME ? path.join(process.env.HOME, ".npm-global/bin/openclaw") : null,
    "/volume1/homes/liunice/.npm-global/bin/openclaw",
    "/usr/local/bin/openclaw",
    "/usr/bin/openclaw",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, "openclaw");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }

  return null;
}

/** Reads the best available summary source after the child process exits. */
async function buildSummary(
  context: RunContext,
  capturedStdout: string,
  capturedStderr: string,
  exitCode: number,
): Promise<string> {
  const fileSummary = await readOptionalText(context.summaryPath);
  if (fileSummary) {
    return trimSummary(fileSummary);
  }

  const claudeSummary = extractClaudeSummary(capturedStdout);
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

/** Builds a readable log file prelude for each run. */
function buildLogHeader(
  options: CliOptions,
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
  const timestamp = startedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const name = sanitizeSegment(label ?? agent);
  return `${timestamp}-${name}`;
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

/** Reads a UTF-8 text file if it exists, otherwise returns null. */
async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
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
