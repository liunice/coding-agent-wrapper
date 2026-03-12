/**
 * Stops active wrapper runs and updates persisted status artifacts.
 * Important note: cancellation prefers graceful shutdown before escalation.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { patchRunStatus, readRunStatus } from "./status";
import type {
  RunCliOptions,
  RunContext,
  RunStatusSnapshot,
  StopCliOptions,
} from "./types";

export async function stopRun(options: StopCliOptions): Promise<number> {
  if (!options.runId) {
    throw new Error("--run-id is required for stop");
  }

  const context = await buildStopContext(options.outputRoot, options.runId);
  const status = await readRunStatus(context.statusPath);
  if (!status) {
    throw new Error(`Run not found or missing status.json: ${options.runId}`);
  }

  if (status.resultState !== "pending") {
    process.stdout.write(
      `${JSON.stringify(
        {
          runId: status.runId,
          status: status.status,
          message: "Run already finished.",
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const stopRequestedAt = new Date().toISOString();
  await patchRunStatus(buildPatchOptions(status), context, {
    stopRequestedAt,
    stopRequestedBy: "user",
    summary: "Stop requested by user; waiting for graceful shutdown.",
  });
  await appendStopLog(context.logPath, stopRequestedAt);

  const pid = status.pid;
  if (!pid || !isProcessAlive(pid)) {
    await finalizeCancelledWithoutProcess(status, context);
    process.stdout.write(
      `${JSON.stringify(
        {
          runId: status.runId,
          status: "cancelled",
          message:
            "Run marked cancelled because wrapper process was already gone.",
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.kill(pid, "SIGTERM");

  const gracefulExit = await waitForExit(pid, 12000);
  if (!gracefulExit && isProcessAlive(pid)) {
    process.kill(pid, "SIGKILL");
    await waitForExit(pid, 3000);
  }

  const refreshed = await readRunStatus(context.statusPath);
  process.stdout.write(
    `${JSON.stringify(
      {
        runId: status.runId,
        status: refreshed?.status ?? "cancelled",
        message: gracefulExit
          ? "Stop signal delivered and run exited."
          : "Stop escalated to SIGKILL.",
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

function buildStopContext(
  outputRoot: string,
  runId: string,
): Promise<RunContext> {
  const runDir = path.resolve(outputRoot, runId);
  return Promise.resolve({
    runId,
    runDir,
    logPath: path.join(runDir, "run.log"),
    agentActivityPath: path.join(runDir, "agent-activity.json"),
    resultPath: path.join(runDir, "result.json"),
    statusPath: path.join(runDir, "status.json"),
    summaryPath: path.join(runDir, "agent-summary.txt"),
    reportPath: path.join(runDir, "agent-report.json"),
    startedAt: new Date().toISOString(),
    taskSummary: "",
    repoSnapshot: null,
  });
}

function buildPatchOptions(status: RunStatusSnapshot): RunCliOptions {
  return {
    command: "run",
    agent: status.agent,
    cwd: status.cwd,
    task: status.taskSummary,
    label: status.label,
    detach: false,
    outputRoot: path.dirname(path.dirname(status.statusPath)),
    internalRun: false,
    runId: status.runId,
    startedAt: status.startedAt,
    resumeMode: "auto",
    passthroughArgs: [],
  };
}

async function appendStopLog(
  logPath: string,
  stopRequestedAt: string,
): Promise<void> {
  const existing = await readOptionalText(logPath);
  const line = `\n[wrapper] stop requested by user at ${stopRequestedAt}\n`;
  await writeFile(logPath, `${existing ?? ""}${line}`, "utf8");
}

async function finalizeCancelledWithoutProcess(
  status: RunStatusSnapshot,
  context: RunContext,
): Promise<void> {
  const finishedAt = new Date().toISOString();
  const resultContent = await readOptionalText(context.resultPath);
  if (resultContent) {
    try {
      const parsed = JSON.parse(resultContent) as Record<string, unknown>;
      parsed.status = "cancelled";
      parsed.finishedAt = finishedAt;
      parsed.exitCode = null;
      parsed.terminationReason = "user_cancelled_after_wrapper_loss";
      parsed.summary =
        "Run was cancelled by user after the wrapper process was no longer alive.";
      await writeFile(
        context.resultPath,
        `${JSON.stringify(parsed, null, 2)}\n`,
        "utf8",
      );
    } catch {
      // ignore malformed result.json
    }
  }

  await patchRunStatus(buildPatchOptions(status), context, {
    finishedAt,
    phase: "cancelled",
    status: "cancelled",
    resultState: "cancelled",
    summary: "Run cancelled by user after wrapper process was already gone.",
    stopRequestedAt: status.stopRequestedAt ?? finishedAt,
    stopRequestedBy: status.stopRequestedBy ?? "user",
    runtimeState: {
      pid: status.pid,
      claimedAt: status.claimedAt,
      terminationReason: "user_cancelled_after_wrapper_loss",
    },
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return !isProcessAlive(pid);
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
