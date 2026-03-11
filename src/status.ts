import { readFile, writeFile } from "node:fs/promises";

import type {
  CliOptions,
  RunContext,
  RunPhase,
  RunRuntimeState,
  RunStatus,
  RunStatusSnapshot,
} from "./types";

interface RunStatusUpdate {
  finishedAt?: string | null;
  phase?: RunPhase;
  summary?: string;
  status?: RunStatus;
  resultState?: "pending" | "success" | "failed";
  sessionId?: string | null;
  resumedFromSessionId?: string | null;
  lastProgressAt?: string | null;
  reporting?: {
    lastReportAt?: string | null;
    lastReportedPhase?: RunPhase | null;
    reportCountIncrement?: number;
  };
  runtimeState?: RunRuntimeState;
}

const DEFAULT_REPORTING_STATE = {
  lastReportAt: null,
  lastReportedPhase: null,
  reportCount: 0,
} as const;

export async function initializeRunStatus(
  options: CliOptions,
  context: RunContext,
  runtimeState: RunRuntimeState,
  summary = "Run created.",
): Promise<RunStatusSnapshot> {
  const now = new Date().toISOString();
  const snapshot: RunStatusSnapshot = {
    runId: context.runId,
    agent: options.agent,
    cwd: options.cwd,
    label: options.label,
    taskSummary: context.taskSummary,
    startedAt: context.startedAt,
    updatedAt: now,
    finishedAt: null,
    phase: options.detach && !options.internalRun ? "queued" : "starting",
    summary,
    status: "running",
    resultState: "pending",
    logPath: context.logPath,
    resultPath: context.resultPath,
    statusPath: context.statusPath,
    summaryPath: context.summaryPath,
    reportPath: context.reportPath,
    sessionId: null,
    resumedFromSessionId: null,
    pid: runtimeState.pid,
    claimedAt: runtimeState.claimedAt,
    terminationReason: runtimeState.terminationReason,
    lastProgressAt: now,
    reporting: { ...DEFAULT_REPORTING_STATE },
  };

  await writeRunStatus(context.statusPath, snapshot);
  return snapshot;
}

export async function patchRunStatus(
  options: CliOptions,
  context: RunContext,
  update: RunStatusUpdate,
): Promise<RunStatusSnapshot> {
  const current = await readRunStatus(context.statusPath);
  const now = new Date().toISOString();
  const next: RunStatusSnapshot = {
    ...(current ?? createFallbackSnapshot(options, context)),
    updatedAt: now,
    finishedAt:
      update.finishedAt !== undefined
        ? update.finishedAt
        : (current?.finishedAt ?? null),
    phase: update.phase ?? current?.phase ?? "running",
    summary: update.summary ?? current?.summary ?? "Run in progress.",
    status: update.status ?? current?.status ?? "running",
    resultState: update.resultState ?? current?.resultState ?? "pending",
    sessionId:
      update.sessionId !== undefined
        ? update.sessionId
        : (current?.sessionId ?? null),
    resumedFromSessionId:
      update.resumedFromSessionId !== undefined
        ? update.resumedFromSessionId
        : (current?.resumedFromSessionId ?? null),
    pid: update.runtimeState?.pid ?? current?.pid ?? null,
    claimedAt: update.runtimeState?.claimedAt ?? current?.claimedAt ?? null,
    terminationReason:
      update.runtimeState?.terminationReason ??
      current?.terminationReason ??
      null,
    lastProgressAt:
      update.lastProgressAt !== undefined
        ? update.lastProgressAt
        : shouldBumpProgressTimestamp(update)
          ? now
          : (current?.lastProgressAt ?? null),
    reporting: {
      ...(current?.reporting ?? { ...DEFAULT_REPORTING_STATE }),
      lastReportAt:
        update.reporting?.lastReportAt !== undefined
          ? update.reporting.lastReportAt
          : (current?.reporting.lastReportAt ??
            DEFAULT_REPORTING_STATE.lastReportAt),
      lastReportedPhase:
        update.reporting?.lastReportedPhase !== undefined
          ? update.reporting.lastReportedPhase
          : (current?.reporting.lastReportedPhase ??
            DEFAULT_REPORTING_STATE.lastReportedPhase),
      reportCount:
        (current?.reporting.reportCount ??
          DEFAULT_REPORTING_STATE.reportCount) +
        (update.reporting?.reportCountIncrement ?? 0),
    },
  };

  await writeRunStatus(context.statusPath, next);
  return next;
}

export async function readRunStatus(
  filePath: string,
): Promise<RunStatusSnapshot | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as RunStatusSnapshot;
  } catch {
    return null;
  }
}

async function writeRunStatus(
  filePath: string,
  snapshot: RunStatusSnapshot,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

function shouldBumpProgressTimestamp(update: RunStatusUpdate): boolean {
  return Boolean(
    update.phase !== undefined ||
      update.summary !== undefined ||
      update.sessionId !== undefined ||
      update.resultState !== undefined,
  );
}

function createFallbackSnapshot(
  options: CliOptions,
  context: RunContext,
): RunStatusSnapshot {
  return {
    runId: context.runId,
    agent: options.agent,
    cwd: options.cwd,
    label: options.label,
    taskSummary: context.taskSummary,
    startedAt: context.startedAt,
    updatedAt: context.startedAt,
    finishedAt: null,
    phase: "starting",
    summary: "Run created.",
    status: "running",
    resultState: "pending",
    logPath: context.logPath,
    resultPath: context.resultPath,
    statusPath: context.statusPath,
    summaryPath: context.summaryPath,
    reportPath: context.reportPath,
    sessionId: null,
    resumedFromSessionId: null,
    pid: null,
    claimedAt: null,
    terminationReason: null,
    lastProgressAt: context.startedAt,
    reporting: { ...DEFAULT_REPORTING_STATE },
  };
}
