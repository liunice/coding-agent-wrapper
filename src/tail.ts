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

/** Allows probes to exercise the interactive TTY path without a real terminal. */
const FORCE_TTY_ENV = "CODING_AGENT_WRAPPER_TAIL_FORCE_TTY";

/** Prefix used by wrapper-internal log lines. */
const WRAPPER_LOG_PREFIX = "[wrapper]";

/** Placeholder shown when filtering hides every visible line in TTY mode. */
const FILTERED_TTY_PLACEHOLDER =
  "(暂无可见日志；当前已隐藏 [wrapper] 行，使用 --include-wrapper 查看。)";

/** Placeholder shown when no log lines exist yet in TTY mode. */
const EMPTY_TTY_PLACEHOLDER = "(暂无日志输出。)";

/** Matches the sortable timestamp prefix embedded in normal run ids. */
const RUN_ID_TIMESTAMP_PATTERN = /^(\d{14})(?:-|$)/;

interface ResolvedTailTarget {
  runId: string;
  runDir: string;
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

interface TailSnapshot {
  fileSize: number;
  trailingPartialLine: string;
  frame: string;
}

interface ParsedLogContent {
  completeLines: string[];
  trailingPartialLine: string;
  displayLines: string[];
}

interface StreamingFilterState {
  includeWrapper: boolean;
  trailingPartialLine: string;
}

/** Runs the `tail` subcommand against one wrapper run log. */
export async function tailRunLog(options: TailCliOptions): Promise<number> {
  const target = await resolveTailTarget(options);
  const useInteractiveFollow = shouldUseInteractiveFollow(options);
  const isTtyOutput = isTailTtyOutput();

  const initialSnapshot = await readTailSnapshot(
    target,
    options,
    useInteractiveFollow || isTtyOutput,
  );
  writeOutput(initialSnapshot.frame);

  if (!options.follow) {
    return 0;
  }

  if (useInteractiveFollow) {
    await followLogFileWithTty(target, options, initialSnapshot.frame);
    return 0;
  }

  await followLogFileNonTty(
    target.logPath,
    initialSnapshot.fileSize,
    createStreamingFilterState(
      options.includeWrapper,
      initialSnapshot.trailingPartialLine,
    ),
  );
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

  return {
    runId,
    runDir,
    logPath,
    statusText: await readTailStatusText(runDir),
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

/** Reads the live header status text for one run. */
async function readTailStatusText(runDir: string): Promise<string> {
  const [status, result] = await Promise.all([
    readRunStatus(path.join(runDir, "status.json")),
    readRunResult(path.join(runDir, "result.json")),
  ]);
  return formatRunStatus(status, result);
}

/** Reads the current tail snapshot after wrapper filtering and line selection. */
async function readTailSnapshot(
  target: ResolvedTailTarget,
  options: TailCliOptions,
  isTtyOutput: boolean,
): Promise<TailSnapshot> {
  const [stats, content, statusText] = await Promise.all([
    stat(target.logPath),
    readFile(target.logPath, "utf8"),
    readTailStatusText(target.runDir).catch(() => target.statusText),
  ]);
  const parsed = parseLogContent(content);
  const visibleLines = filterVisibleLines(
    parsed.displayLines,
    options.includeWrapper,
  );
  const selectedLines = visibleLines.slice(-options.lines);
  const bodyLines =
    selectedLines.length > 0
      ? selectedLines
      : buildTtyPlaceholderLines(
          parsed.displayLines,
          visibleLines,
          options,
          isTtyOutput,
        );

  return {
    fileSize: stats.size,
    trailingPartialLine: parsed.trailingPartialLine,
    frame: `${buildHeaderText(target.runId, statusText)}${renderBodyLines(bodyLines)}`,
  };
}

/** Follows appended file content in non-TTY mode while preserving append semantics. */
async function followLogFileNonTty(
  filePath: string,
  initialOffset: number,
  state: StreamingFilterState,
): Promise<void> {
  let currentOffset = initialOffset;

  await new Promise<void>((resolve, reject) => {
    let stopped = false;
    let polling = false;

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
      if (polling || stopped) {
        return;
      }

      polling = true;
      void readAppendedContent(filePath, currentOffset)
        .then(({ nextOffset, text, resetState }) => {
          currentOffset = nextOffset;
          writeOutput(consumeFilteredAppendChunk(state, text, resetState));
        })
        .catch((error: unknown) => {
          clearInterval(timer);
          process.off("SIGINT", handleSignal);
          process.off("SIGTERM", handleSignal);
          reject(error);
        })
        .finally(() => {
          polling = false;
        });
    }, FOLLOW_POLL_INTERVAL_MS);

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
  });
}

/** Follows one log file in TTY mode by redrawing a fixed visible region. */
async function followLogFileWithTty(
  target: ResolvedTailTarget,
  options: TailCliOptions,
  initialFrame: string,
): Promise<void> {
  let lastFrame = initialFrame;
  let renderedLineCount = countRenderedLines(initialFrame);

  await new Promise<void>((resolve, reject) => {
    let stopped = false;
    let polling = false;

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
      if (polling || stopped) {
        return;
      }

      polling = true;
      void readTailSnapshot(target, options, true)
        .then((snapshot) => {
          if (snapshot.frame === lastFrame) {
            return;
          }

          const prefix = buildTtyRedrawPrefix(renderedLineCount);
          process.stdout.write(`${prefix}${snapshot.frame}`);
          lastFrame = snapshot.frame;
          renderedLineCount = countRenderedLines(snapshot.frame);
        })
        .catch((error: unknown) => {
          clearInterval(timer);
          process.off("SIGINT", handleSignal);
          process.off("SIGTERM", handleSignal);
          reject(error);
        })
        .finally(() => {
          polling = false;
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
): Promise<{ nextOffset: number; text: string; resetState: boolean }> {
  const stats = await stat(filePath);
  if (stats.size <= offset) {
    if (stats.size < offset) {
      const range = await readAppendedRange(filePath, 0, stats.size);
      return {
        ...range,
        resetState: true,
      };
    }

    return { nextOffset: offset, text: "", resetState: false };
  }

  const range = await readAppendedRange(filePath, offset, stats.size);
  return {
    ...range,
    resetState: false,
  };
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

/** Parses log content into complete lines plus one possible trailing partial line. */
function parseLogContent(content: string): ParsedLogContent {
  const endsWithNewline = content.endsWith("\n");
  const rawLines = content.split(/\r?\n/);

  if (endsWithNewline) {
    const completeLines = rawLines.slice(0, -1);
    return {
      completeLines,
      trailingPartialLine: "",
      displayLines: completeLines,
    };
  }

  const trailingPartialLine = rawLines.pop() ?? "";
  return {
    completeLines: rawLines,
    trailingPartialLine,
    displayLines: trailingPartialLine
      ? [...rawLines, trailingPartialLine]
      : rawLines,
  };
}

/** Filters wrapper-internal lines before line selection. */
function filterVisibleLines(
  lines: string[],
  includeWrapper: boolean,
): string[] {
  if (includeWrapper) {
    return lines;
  }

  return lines.filter((line) => !line.startsWith(WRAPPER_LOG_PREFIX));
}

/** Creates the streaming filter state used by non-TTY follow mode. */
function createStreamingFilterState(
  includeWrapper: boolean,
  trailingPartialLine: string,
): StreamingFilterState {
  return {
    includeWrapper,
    trailingPartialLine,
  };
}

/** Filters appended chunks line-by-line while keeping non-TTY output append-based. */
function consumeFilteredAppendChunk(
  state: StreamingFilterState,
  chunk: string,
  resetState: boolean,
): string {
  if (!chunk) {
    if (resetState) {
      state.trailingPartialLine = "";
    }
    return "";
  }

  const parsed = parseLogContent(
    `${resetState ? "" : state.trailingPartialLine}${chunk}`,
  );
  state.trailingPartialLine = parsed.trailingPartialLine;

  const visibleLines = filterVisibleLines(
    parsed.completeLines,
    state.includeWrapper,
  );
  return renderBodyLines(visibleLines);
}

/** Builds TTY placeholder lines when no visible body lines remain. */
function buildTtyPlaceholderLines(
  rawDisplayLines: string[],
  visibleLines: string[],
  options: TailCliOptions,
  isTtyOutput: boolean,
): string[] {
  if (!isTtyOutput) {
    return [];
  }

  if (
    rawDisplayLines.length > 0 &&
    visibleLines.length === 0 &&
    !options.includeWrapper
  ) {
    return [FILTERED_TTY_PLACEHOLDER];
  }

  if (rawDisplayLines.length === 0) {
    return [EMPTY_TTY_PLACEHOLDER];
  }

  return [];
}

/** Builds the stable tail header text. */
function buildHeaderText(runId: string, statusText: string): string {
  return `Run ID: ${runId}\nStatus: ${statusText}\n\n`;
}

/** Renders selected body lines with a trailing newline when non-empty. */
function renderBodyLines(lines: string[]): string {
  if (lines.length === 0) {
    return "";
  }

  return `${lines.join("\n")}\n`;
}

/** Counts the number of rendered terminal lines in one frame. */
function countRenderedLines(frame: string): number {
  return (frame.match(/\n/g) ?? []).length;
}

/** Builds the ANSI prefix that redraws the previous frame in place. */
function buildTtyRedrawPrefix(renderedLineCount: number): string {
  if (renderedLineCount <= 0) {
    return "";
  }

  return `\u001b[${renderedLineCount}A\r\u001b[J`;
}

/** Returns whether tail output should use the interactive TTY follow path. */
function shouldUseInteractiveFollow(options: TailCliOptions): boolean {
  return options.follow && isTailTtyOutput();
}

/** Returns whether tail should treat stdout as a TTY for rendering purposes. */
function isTailTtyOutput(): boolean {
  return Boolean(process.stdout.isTTY) || process.env[FORCE_TTY_ENV] === "1";
}

/** Writes log output chunks without adding extra formatting. */
function writeOutput(text: string): void {
  if (!text) {
    return;
  }

  process.stdout.write(text);
}
