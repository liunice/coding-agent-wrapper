/**
 * Provides a wrapper-native tail command for run logs.
 * Important note: it can resolve the latest run automatically and always
 * prints a small run header before the tailed log content.
 */

import { constants } from "node:fs";
import { access, open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { readRunStatus } from "./status";
import type { RunResult, RunStatusSnapshot, TailCliOptions } from "./types";

/** Poll interval for follow mode when checking for appended log content. */
const FOLLOW_POLL_INTERVAL_MS = 500;

/** Matches the sortable timestamp prefix embedded in normal run ids. */
const RUN_ID_TIMESTAMP_PATTERN = /^(\d{14})(?:-|$)/;

interface ResolvedTailTarget {
  runId: string;
  logPath: string;
  statusText: string;
}

interface RunCandidate {
  runId: string;
  runDir: string;
  startedAtMs: number;
  modifiedAtMs: number;
  timestampPrefix: number | null;
  isRunning: boolean;
}

/** Runs the `tail` subcommand against one wrapper run log. */
export async function tailRunLog(options: TailCliOptions): Promise<number> {
  const target = await resolveTailTarget(options);
  writeHeader(target);

  const { fileSize, text } = await readLastLines(target.logPath, options.lines);
  writeOutput(text);

  if (!options.follow) {
    return 0;
  }

  await followLogFile(target.logPath, fileSize);
  return 0;
}

/** Resolves the target run, log path, and header metadata for one tail request. */
async function resolveTailTarget(
  options: TailCliOptions,
): Promise<ResolvedTailTarget> {
  const runId = options.runId ?? (await resolveLatestRunId(options.outputRoot));
  const runDir = path.resolve(options.outputRoot, runId);
  const logPath = path.join(runDir, "run.log");

  try {
    await access(logPath, constants.F_OK | constants.R_OK);
  } catch {
    throw new Error(`Run log not found for runId ${runId}: ${logPath}`);
  }

  const [status, result] = await Promise.all([
    readRunStatus(path.join(runDir, "status.json")),
    readRunResult(path.join(runDir, "result.json")),
  ]);

  return {
    runId,
    logPath,
    statusText: formatRunStatus(status, result),
  };
}

/** Resolves the most recent run following the dev-plan selection rules. */
async function resolveLatestRunId(outputRoot: string): Promise<string> {
  let entries: Array<{ isDirectory(): boolean; name: string }> = [];
  try {
    entries = await readdir(outputRoot, { withFileTypes: true });
  } catch {
    throw new Error(`No runs found in output root: ${outputRoot}`);
  }

  const candidates = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name !== "active-runs")
        .map(async (entry) => await readRunCandidate(outputRoot, entry.name)),
    )
  ).filter((candidate): candidate is RunCandidate => candidate !== null);

  if (candidates.length === 0) {
    throw new Error(`No runs found in output root: ${outputRoot}`);
  }

  const runningCandidates = candidates.filter(
    (candidate) => candidate.isRunning,
  );
  const pool = runningCandidates.length > 0 ? runningCandidates : candidates;
  pool.sort(compareRunCandidates);
  return pool[0].runId;
}

/** Reads one run directory into a sortable candidate for latest-run resolution. */
async function readRunCandidate(
  outputRoot: string,
  runId: string,
): Promise<RunCandidate | null> {
  const runDir = path.resolve(outputRoot, runId);
  const [runStat, status, result] = await Promise.all([
    stat(runDir).catch(() => null),
    readRunStatus(path.join(runDir, "status.json")),
    readRunResult(path.join(runDir, "result.json")),
  ]);

  if (!runStat) {
    return null;
  }

  return {
    runId,
    runDir,
    startedAtMs: resolveStartedAtMs(status, result),
    modifiedAtMs: runStat.mtimeMs,
    timestampPrefix: readRunIdTimestampPrefix(runId),
    isRunning: isRunConsideredRunning(status, result),
  };
}

/** Sorts candidates by run-id timestamp prefix, then by fallback timestamps. */
function compareRunCandidates(left: RunCandidate, right: RunCandidate): number {
  if (left.timestampPrefix !== right.timestampPrefix) {
    if (left.timestampPrefix === null) {
      return 1;
    }
    if (right.timestampPrefix === null) {
      return -1;
    }
    return right.timestampPrefix - left.timestampPrefix;
  }

  if (left.startedAtMs !== right.startedAtMs) {
    return right.startedAtMs - left.startedAtMs;
  }

  if (left.modifiedAtMs !== right.modifiedAtMs) {
    return right.modifiedAtMs - left.modifiedAtMs;
  }

  return right.runId.localeCompare(left.runId);
}

/** Reads the numeric timestamp prefix from a normal wrapper run id. */
function readRunIdTimestampPrefix(runId: string): number | null {
  const match = RUN_ID_TIMESTAMP_PATTERN.exec(runId);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Resolves whether a run should count as currently running. */
function isRunConsideredRunning(
  status: RunStatusSnapshot | null,
  result: RunResult | null,
): boolean {
  if (result?.status === "running") {
    return true;
  }

  if (status?.status === "running") {
    return true;
  }

  return (
    status?.finishedAt === null &&
    (status.phase === "queued" ||
      status.phase === "starting" ||
      status.phase === "running" ||
      status.phase === "summarizing")
  );
}

/** Resolves a sortable started-at timestamp from status/result metadata. */
function resolveStartedAtMs(
  status: RunStatusSnapshot | null,
  result: RunResult | null,
): number {
  const rawValue = status?.startedAt ?? result?.startedAt ?? null;
  if (!rawValue) {
    return 0;
  }

  const parsed = Date.parse(rawValue);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Formats the tail header status line from status/result metadata. */
function formatRunStatus(
  status: RunStatusSnapshot | null,
  result: RunResult | null,
): string {
  if (isRunConsideredRunning(status, result)) {
    return "running";
  }

  const resolvedStatus = result?.status ?? status?.status ?? null;
  const resolvedExitCode = result?.exitCode ?? null;

  if (resolvedStatus && resolvedStatus !== "running") {
    return `${resolvedStatus} (exit ${resolvedExitCode ?? "unknown"})`;
  }

  if (status?.phase === "completed") {
    return `success (exit ${resolvedExitCode ?? "unknown"})`;
  }

  return "unknown";
}

/** Reads the run result file when available. */
async function readRunResult(filePath: string): Promise<RunResult | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as RunResult;
  } catch {
    return null;
  }
}

/** Writes the required run metadata header before any tailed log content. */
function writeHeader(target: ResolvedTailTarget): void {
  process.stdout.write(
    `Run ID: ${target.runId}\nStatus: ${target.statusText}\n\n`,
  );
}

/** Reads the last N lines without depending on the system tail binary. */
async function readLastLines(
  filePath: string,
  lineCount: number,
): Promise<{ fileSize: number; text: string }> {
  const file = await open(filePath, "r");

  try {
    const stats = await file.stat();
    const fileSize = stats.size;

    if (fileSize === 0) {
      return { fileSize, text: "" };
    }

    const chunkSize = 64 * 1024;
    let position = fileSize;
    let bufferedText = "";
    let newlineCount = 0;

    while (position > 0 && newlineCount <= lineCount) {
      const bytesToRead = Math.min(chunkSize, position);
      position -= bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
      const chunk = buffer.subarray(0, bytesRead).toString("utf8");
      bufferedText = `${chunk}${bufferedText}`;
      newlineCount = countNewlines(bufferedText);
    }

    return {
      fileSize,
      text: selectLastLines(bufferedText, lineCount),
    };
  } finally {
    await file.close();
  }
}

/** Follows appended file content until the user interrupts the command. */
async function followLogFile(
  filePath: string,
  initialOffset: number,
): Promise<void> {
  let currentOffset = initialOffset;

  await new Promise<void>((resolve, reject) => {
    let stopped = false;

    const stopFollowing = (): void => {
      if (stopped) {
        return;
      }

      stopped = true;
      clearInterval(timer);
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      resolve();
    };

    const handleSignal = (): void => {
      stopFollowing();
    };

    const timer = setInterval(() => {
      void readAppendedContent(filePath, currentOffset)
        .then(({ nextOffset, text }) => {
          currentOffset = nextOffset;
          writeOutput(text);
        })
        .catch((error: unknown) => {
          clearInterval(timer);
          process.off("SIGINT", handleSignal);
          process.off("SIGTERM", handleSignal);
          reject(error);
        });
    }, FOLLOW_POLL_INTERVAL_MS);

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
  });
}

/** Reads any newly appended bytes since the previous follow offset. */
async function readAppendedContent(
  filePath: string,
  offset: number,
): Promise<{ nextOffset: number; text: string }> {
  const stats = await stat(filePath);
  if (stats.size <= offset) {
    if (stats.size < offset) {
      return await readAppendedRange(filePath, 0, stats.size);
    }

    return { nextOffset: offset, text: "" };
  }

  return await readAppendedRange(filePath, offset, stats.size);
}

/** Reads a byte range from the file and returns the new follow offset. */
async function readAppendedRange(
  filePath: string,
  startOffset: number,
  endOffset: number,
): Promise<{ nextOffset: number; text: string }> {
  const file = await open(filePath, "r");

  try {
    const bytesToRead = Math.max(0, endOffset - startOffset);
    if (bytesToRead === 0) {
      return { nextOffset: endOffset, text: "" };
    }

    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, startOffset);
    return {
      nextOffset: startOffset + bytesRead,
      text: buffer.subarray(0, bytesRead).toString("utf8"),
    };
  } finally {
    await file.close();
  }
}

/** Counts line breaks in a UTF-8 string. */
function countNewlines(value: string): number {
  return (value.match(/\n/g) ?? []).length;
}

/** Selects the last N logical lines while preserving their trailing newline. */
function selectLastLines(value: string, lineCount: number): string {
  const endsWithNewline = value.endsWith("\n");
  const rawLines = value.split(/\r?\n/);
  const lines = endsWithNewline ? rawLines.slice(0, -1) : rawLines;
  const selected = lines.slice(-lineCount).join("\n");

  if (!selected) {
    return "";
  }

  return endsWithNewline ? `${selected}\n` : selected;
}

/** Writes log output chunks without adding extra formatting. */
function writeOutput(text: string): void {
  if (!text) {
    return;
  }

  process.stdout.write(text);
}
