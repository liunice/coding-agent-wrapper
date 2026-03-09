/**
 * Implements run lifecycle management, logging, result artifacts, and notifications.
 * Important note: detached execution reuses the same CLI with an internal flag.
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { constants, accessSync, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createAgentLaunchSpec } from "./adapters";
import { getCodingAssistantSkillConfig } from "./config";
import {
  createSessionDetectionState,
  detectSessionIdFromStream,
  extractSessionId,
} from "./session-id";
import { saveResumeSessionId } from "./sessions";
import type {
  AgentReport,
  CliOptions,
  RepoSnapshot,
  RunContext,
  RunResult,
  RunStatus,
} from "./types";

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
  const reportPath = path.join(runDir, "agent-report.json");

  await mkdir(runDir, { recursive: true });

  return {
    runId,
    runDir,
    logPath,
    resultPath,
    summaryPath,
    reportPath,
    startedAt,
    taskSummary: summarizeTask(options.task),
    repoSnapshot: await captureRepoSnapshot(options.cwd),
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

  const spec = await createAgentLaunchSpec(options, context);
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
    const sessionDetection = createSessionDetectionState();

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
      logStream.write(text);

      if (options.internalRun) {
        return;
      }

      if (streamName === "stdout") {
        process.stdout.write(text);
        return;
      }

      process.stderr.write(text);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      handleChildText("stdout", chunk.toString());
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      handleChildText("stderr", chunk.toString());
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
    let sessionId = sessionDetection.sessionId;

    if (!sessionId) {
      sessionId = await extractSessionIdFromRunLog(
        options.agent,
        context.logPath,
        logStream,
      );
    }

    if (sessionId) {
      await saveResumeSessionId(
        options.outputRoot,
        options.agent,
        options.cwd,
        sessionId,
      );
      logStream.write(`[wrapper] sessionId=${sessionId}\n`);
    }

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
      sessionId,
      spec.resumedSessionId ?? null,
    );
    await notifyCompletion(
      options,
      await buildNotificationText(options, context, status, exitCode),
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
  sessionId: string | null = null,
  resumedFromSessionId: string | null = null,
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
  options: CliOptions,
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

  return [
    `后台任务已完成：${name}`,
    "",
    "**【任务信息】**",
    `• Agent: ${options.agent}`,
    `• 状态: ${status} (exit ${exitCode})`,
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
    `• 结果文件: ${context.resultPath}`,
    `• 日志文件: ${context.logPath}`,
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
  const attempts = buildNotifyAttempts(options, text);

  if (attempts.length === 0) {
    logStream.write("[wrapper] notify skipped=no-target\n");
    return;
  }

  for (const attempt of attempts) {
    logStream.write(
      `[wrapper] notify attempt=${attempt.name} command=${renderCommand(command, attempt.args)}\n`,
    );

    const result = await runNotifyAttempt(command, attempt.args, logStream);
    if (result === 0) {
      return;
    }
  }
}

/** Resolves an absolute openclaw binary path when PATH inheritance is unreliable. */
function buildNotifyAttempts(
  options: CliOptions,
  text: string,
): Array<{ name: string; args: string[] }> {
  const attempts: Array<{ name: string; args: string[] }> = [];
  const skillNotify = getCodingAssistantSkillConfig().notify ?? {};
  const notifyChannel = options.notifyChannel ?? skillNotify.channel;
  const notifyTarget = options.notifyTarget ?? skillNotify.target;
  const notifyAccount = options.notifyAccount ?? skillNotify.accountId;
  const notifyReplyTo = options.notifyReplyTo ?? skillNotify.replyTo;
  const notifyThreadId = options.notifyThreadId ?? skillNotify.threadId;
  const notifySessionKey = options.notifySessionKey ?? skillNotify.sessionKey;

  if (notifyTarget) {
    const args = [
      "message",
      "send",
      "--target",
      notifyTarget,
      "--message",
      text,
    ];

    if (notifyChannel) {
      args.push("--channel", notifyChannel);
    }
    if (notifyAccount) {
      args.push("--account", notifyAccount);
    }
    if (notifyReplyTo) {
      args.push("--reply-to", notifyReplyTo);
    }
    if (notifyThreadId) {
      args.push("--thread-id", notifyThreadId);
    }

    attempts.push({ name: "message-send", args });
  }

  if (notifySessionKey) {
    // TODO(webchat): `chat.inject` already writes the completion note into the target
    // session transcript, but Control UI / webchat does not always surface that
    // injected assistant message in the live chat view. Keep this session fallback
    // for now, but revisit the Control UI rendering / subscription path later.
    const params = {
      sessionKey: notifySessionKey,
      message: text,
      label: "coding-agent-wrapper",
    };

    attempts.push({
      name: "chat-inject",
      args: [
        "gateway",
        "call",
        "chat.inject",
        "--params",
        JSON.stringify(params),
        "--timeout",
        "10000",
      ],
    });
  }

  if (attempts.length === 0) {
    attempts.push({
      name: "system-event",
      args: ["system", "event", "--text", text, "--mode", "now"],
    });
  }

  return attempts;
}

async function runNotifyAttempt(
  command: string,
  args: string[],
  logStream: ReturnType<typeof createWriteStream>,
): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      env: process.env,
    });

    child.on("close", (code) => {
      logStream.write(`[wrapper] notify exit=${code ?? "null"}\n`);
      resolve(code ?? null);
    });

    child.on("error", (error) => {
      logStream.write(`[wrapper] notify error=${error.message}\n`);
      resolve(null);
    });
  });
}

function resolveOpenClawBinary(): string | null {
  const candidates = [
    process.env.OPENCLAW_BIN,
    process.env.npm_config_prefix
      ? path.join(process.env.npm_config_prefix, "bin", "openclaw")
      : null,
    process.env.HOME
      ? path.join(process.env.HOME, ".npm-global/bin/openclaw")
      : null,
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

  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
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

/**
 * Flushes child output to disk and scans the full run log when stream-time
 * detection did not find a session id.
 */
async function extractSessionIdFromRunLog(
  agent: CliOptions["agent"],
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
