import { readFile, writeFile } from "node:fs/promises";

import type {
  RunCliOptions,
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
  resultState?: "pending" | "success" | "failed" | "cancelled";
  sessionId?: string | null;
  resumedFromSessionId?: string | null;
  stopRequestedAt?: string | null;
  stopRequestedBy?: string | null;
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
  options: RunCliOptions,
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
    childPid: runtimeState.childPid ?? null,
    stopRequestedAt: null,
    stopRequestedBy: null,
    claimedAt: runtimeState.claimedAt,
    terminationReason: runtimeState.terminationReason,
    lastProgressAt: now,
    reporting: { ...DEFAULT_REPORTING_STATE },
  };

  await writeRunStatus(context.statusPath, snapshot);
  return snapshot;
}

export async function patchRunStatus(
  options: RunCliOptions,
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
    stopRequestedAt:
      update.stopRequestedAt !== undefined
        ? update.stopRequestedAt
        : (current?.stopRequestedAt ?? null),
    stopRequestedBy:
      update.stopRequestedBy !== undefined
        ? update.stopRequestedBy
        : (current?.stopRequestedBy ?? null),
    pid: update.runtimeState?.pid ?? current?.pid ?? null,
    childPid: update.runtimeState?.childPid ?? current?.childPid ?? null,
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
  options: RunCliOptions,
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
    childPid: null,
    stopRequestedAt: null,
    stopRequestedBy: null,
    claimedAt: null,
    terminationReason: null,
    lastProgressAt: context.startedAt,
    reporting: { ...DEFAULT_REPORTING_STATE },
  };
}
