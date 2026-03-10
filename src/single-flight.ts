/**
 * Enforces same-project single-flight execution with atomic active-lock claims.
 * Important note: stale recovery prefers process identity and result status over
 * heartbeat or log freshness so quiet but healthy runs are not evicted.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  RunContext,
  RunResult,
  RunRuntimeState,
  SupportedAgent,
} from "./types";

/** Stores the active lock directory name under the output root. */
const ACTIVE_RUNS_DIR = "active-runs";

/** Captures the persisted metadata for one active run claim. */
interface ActiveRunClaimRecord {
  claimId: string;
  agent: SupportedAgent;
  cwd: string;
  runId: string;
  startedAt: string;
  claimedAt: string;
  pid: number;
  pidStartTimeTicks: string | null;
  resultPath: string;
}

/** Carries the claimed lock state needed for result writing and release. */
export interface ActiveRunClaimHandle {
  claimFilePath: string;
  record: ActiveRunClaimRecord;
  recoveredStaleReason: string | null;
  released: boolean;
}

/** Describes the currently blocking active run for user-facing errors. */
interface BlockingRunInfo {
  agent: SupportedAgent;
  claimedAt: string;
  cwd: string;
  pid: number;
  resultPath: string;
  runId: string;
  startedAt: string;
}

/** Raises a clear error when same-project single-flight rejects a new run. */
export class SingleFlightError extends Error {
  readonly blockingRun: BlockingRunInfo;

  constructor(blockingRun: BlockingRunInfo) {
    super(buildSingleFlightErrorMessage(blockingRun));
    this.name = "SingleFlightError";
    this.blockingRun = blockingRun;
  }
}

/** Atomically claims the active lock for a new foreground or detached launcher. */
export async function acquireActiveRunClaim(
  outputRoot: string,
  agent: SupportedAgent,
  cwd: string,
  context: RunContext,
): Promise<ActiveRunClaimHandle> {
  const resolvedCwd = path.resolve(cwd);
  const paths = getActiveRunLockPaths(outputRoot, agent, resolvedCwd);
  await mkdir(path.dirname(paths.claimFilePath), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = await buildClaimRecord(agent, resolvedCwd, context);

    try {
      await writeClaimRecordAtomically(paths.claimFilePath, record);
      return {
        claimFilePath: paths.claimFilePath,
        record,
        recoveredStaleReason: null,
        released: false,
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const existing = await inspectExistingClaim(paths.claimFilePath);
      if (existing.state === "active") {
        throw new SingleFlightError(existing.blockingRun);
      }

      await rm(paths.claimFilePath, { force: true });
      if (attempt === 2) {
        throw new Error(
          `Failed to recover stale active lock for ${resolvedCwd}.`,
        );
      }
    }
  }

  throw new Error(`Failed to claim active lock for ${resolvedCwd}.`);
}

/** Adopts an existing detached-run claim or acquires a fresh one when missing. */
export async function adoptActiveRunClaim(
  outputRoot: string,
  agent: SupportedAgent,
  cwd: string,
  context: RunContext,
): Promise<ActiveRunClaimHandle> {
  const resolvedCwd = path.resolve(cwd);
  const paths = getActiveRunLockPaths(outputRoot, agent, resolvedCwd);
  const existing = await readClaimRecord(paths.claimFilePath);

  if (!existing || existing.runId !== context.runId) {
    return await acquireActiveRunClaim(outputRoot, agent, resolvedCwd, context);
  }

  const adopted = await updateClaimOwner(existing, process.pid);
  await writeClaimRecord(paths.claimFilePath, adopted);
  return {
    claimFilePath: paths.claimFilePath,
    record: adopted,
    recoveredStaleReason: null,
    released: false,
  };
}

/** Transfers an existing claim to another wrapper process such as a detached child. */
export async function transferActiveRunClaim(
  handle: ActiveRunClaimHandle,
  pid: number,
): Promise<ActiveRunClaimHandle> {
  const current = await readClaimRecord(handle.claimFilePath);
  if (!current || current.claimId !== handle.record.claimId) {
    throw new Error(
      `Active lock changed before transfer for run ${handle.record.runId}.`,
    );
  }

  const updated = await updateClaimOwner(current, pid);
  await writeClaimRecord(handle.claimFilePath, updated);
  handle.record = updated;
  return handle;
}

/** Releases the active lock when the current owner finishes. */
export async function releaseActiveRunClaim(
  handle: ActiveRunClaimHandle,
): Promise<void> {
  if (handle.released) {
    return;
  }

  const current = await readClaimRecord(handle.claimFilePath);
  handle.released = true;
  if (!current || current.claimId !== handle.record.claimId) {
    return;
  }

  await rm(handle.claimFilePath, { force: true });
}

/** Exposes the runtime ownership fields that should be written into result.json. */
export function getRunRuntimeState(
  handle: ActiveRunClaimHandle,
  terminationReason: string | null = null,
): RunRuntimeState {
  return {
    pid: handle.record.pid,
    claimedAt: handle.record.claimedAt,
    terminationReason,
  };
}

/** Resolves the filesystem paths used by the active lock for one agent+cowd pair. */
export function getActiveRunLockPaths(
  outputRoot: string,
  agent: SupportedAgent,
  cwd: string,
): { claimFilePath: string } {
  const resolvedCwd = path.resolve(cwd);
  const hash = createHash("sha1")
    .update(resolvedCwd)
    .digest("hex")
    .slice(0, 16);

  return {
    claimFilePath: path.resolve(outputRoot, ACTIVE_RUNS_DIR, `${hash}.json`),
  };
}

/** Creates the persisted claim record for a newly started wrapper process. */
async function buildClaimRecord(
  agent: SupportedAgent,
  cwd: string,
  context: RunContext,
): Promise<ActiveRunClaimRecord> {
  return {
    claimId: randomUUID(),
    agent,
    cwd,
    runId: context.runId,
    startedAt: context.startedAt,
    claimedAt: new Date().toISOString(),
    pid: process.pid,
    pidStartTimeTicks: await readProcessStartTimeTicks(process.pid),
    resultPath: context.resultPath,
  };
}

/** Validates an existing claim and classifies it as active or stale. */
async function inspectExistingClaim(
  claimFilePath: string,
): Promise<
  | { blockingRun: BlockingRunInfo; state: "active" }
  | { reason: string; state: "stale" }
> {
  const claim = await readClaimRecord(claimFilePath);
  if (!claim) {
    return { reason: "missing or invalid claim metadata", state: "stale" };
  }

  const result = await readRunResult(claim.resultPath);
  if (result && result.status !== "running") {
    return {
      reason: `result already finished with status ${result.status}`,
      state: "stale",
    };
  }

  if (!(await isProcessAlive(claim.pid))) {
    return {
      reason: `pid ${claim.pid} is not running`,
      state: "stale",
    };
  }

  const currentStartTimeTicks = await readProcessStartTimeTicks(claim.pid);
  if (
    claim.pidStartTimeTicks &&
    currentStartTimeTicks &&
    claim.pidStartTimeTicks !== currentStartTimeTicks
  ) {
    return {
      reason: `pid ${claim.pid} belongs to a different process instance`,
      state: "stale",
    };
  }

  return {
    blockingRun: {
      agent: claim.agent,
      claimedAt: claim.claimedAt,
      cwd: claim.cwd,
      pid: claim.pid,
      resultPath: claim.resultPath,
      runId: claim.runId,
      startedAt: claim.startedAt,
    },
    state: "active",
  };
}

/** Reads one persisted claim file if it exists and is valid JSON. */
async function readClaimRecord(
  claimFilePath: string,
): Promise<ActiveRunClaimRecord | null> {
  try {
    const content = await readFile(claimFilePath, "utf8");
    const parsed = JSON.parse(content) as Partial<ActiveRunClaimRecord>;
    if (
      typeof parsed.claimId !== "string" ||
      typeof parsed.agent !== "string" ||
      typeof parsed.cwd !== "string" ||
      typeof parsed.runId !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.claimedAt !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.resultPath !== "string"
    ) {
      return null;
    }

    return {
      claimId: parsed.claimId,
      agent: parsed.agent as SupportedAgent,
      cwd: parsed.cwd,
      runId: parsed.runId,
      startedAt: parsed.startedAt,
      claimedAt: parsed.claimedAt,
      pid: parsed.pid,
      pidStartTimeTicks:
        typeof parsed.pidStartTimeTicks === "string"
          ? parsed.pidStartTimeTicks
          : null,
      resultPath: parsed.resultPath,
    };
  } catch {
    return null;
  }
}

/** Persists the claim metadata after acquisition or ownership transfer. */
async function writeClaimRecord(
  claimFilePath: string,
  record: ActiveRunClaimRecord,
): Promise<void> {
  await writeFile(
    claimFilePath,
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

/** Atomically creates a new claim file so concurrent launches cannot both win. */
async function writeClaimRecordAtomically(
  claimFilePath: string,
  record: ActiveRunClaimRecord,
): Promise<void> {
  const handle = await open(claimFilePath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

/** Updates the owner pid fields while keeping the original claim identity. */
async function updateClaimOwner(
  record: ActiveRunClaimRecord,
  pid: number,
): Promise<ActiveRunClaimRecord> {
  return {
    ...record,
    pid,
    pidStartTimeTicks: await readProcessStartTimeTicks(pid),
  };
}

/** Reads result.json for stale detection without coupling to runner helpers. */
async function readRunResult(resultPath: string): Promise<RunResult | null> {
  try {
    const content = await readFile(resultPath, "utf8");
    return JSON.parse(content) as RunResult;
  } catch {
    return null;
  }
}

/** Checks whether a pid is currently alive from the OS perspective. */
async function isProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Reads the Linux /proc start time ticks used to distinguish pid reuse. */
async function readProcessStartTimeTicks(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim();
    const fields = afterCommand.split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** Formats the user-facing rejection message for same-project single-flight. */
function buildSingleFlightErrorMessage(blockingRun: BlockingRunInfo): string {
  return [
    "同一项目已有活跃 run，已拒绝启动新的任务。",
    `Agent: ${blockingRun.agent}`,
    `CWD: ${blockingRun.cwd}`,
    `Run ID: ${blockingRun.runId}`,
    `Started At: ${blockingRun.startedAt}`,
    `Claimed At: ${blockingRun.claimedAt}`,
    `PID: ${blockingRun.pid}`,
    `Result: ${blockingRun.resultPath}`,
    "如果该状态已过期，请直接重试；wrapper 会在检测到进程不存在或结果已结束时自动回收 stale lock。",
  ].join("\n");
}

/** Narrows filesystem errors raised when the active lock already exists. */
function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST",
  );
}
