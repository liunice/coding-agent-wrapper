/**
 * Verifies the wrapper-native tail command in filtered, explicit, and follow modes.
 * Important note: it uses temporary run directories so the probe stays lightweight.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Internal env override used to force the TTY redraw path during probes. */
const FORCE_TTY_ENV = "CODING_AGENT_WRAPPER_TAIL_FORCE_TTY";

/** Runs the tail probe and prints a compact PASS message. */
async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..");
  await cleanupProbeWorkspaces(repoRoot);

  const workspace = path.resolve(
    repoRoot,
    `.probe-workspace-${process.pid}-${Date.now()}`,
  );
  const outputRoot = path.join(workspace, "runs");
  const cliPath = path.resolve(__dirname, "cli.js");

  try {
    await createRunFixture(outputRoot, {
      runId: "20260311100000-explicit-success",
      logLines: [
        "alpha 1",
        "[wrapper] alpha wrapper 1",
        "alpha 2",
        "[wrapper] alpha wrapper 2",
        "alpha 3",
      ],
      status: "success",
      phase: "completed",
      resultStatus: "success",
      exitCode: 0,
      startedAt: "2026-03-11T10:00:00.000Z",
    });
    await createRunFixture(outputRoot, {
      runId: "20260311113000-latest-running",
      logLines: ["beta 1", "[wrapper] beta wrapper 1", "beta 3"],
      status: "running",
      phase: "running",
      resultStatus: "running",
      exitCode: null,
      startedAt: "2026-03-11T11:30:00.000Z",
    });
    await createRunFixture(outputRoot, {
      runId: "20260311114500-wrapper-only-running",
      logLines: ["[wrapper] hidden 1", "[wrapper] hidden 2"],
      status: "running",
      phase: "running",
      resultStatus: "running",
      exitCode: null,
      startedAt: "2026-03-11T11:45:00.000Z",
    });
    await createRunFixture(outputRoot, {
      runId: "20260311120000-newer-finished",
      logLines: ["gamma 1", "[wrapper] gamma wrapper"],
      status: "success",
      phase: "completed",
      resultStatus: "success",
      exitCode: 0,
      startedAt: "2026-03-11T12:00:00.000Z",
    });

    verifyDefaultWrapperExclusion(cliPath, outputRoot);
    verifyExplicitIncludeWrapper(cliPath, outputRoot);
    verifyExplicitExcludeWrapper(cliPath, outputRoot);
    verifyLatestRunning(cliPath, outputRoot);
    await verifyLatestOverallFallback(cliPath, workspace);
    await verifyNonTtyFollowAppend(cliPath, outputRoot);
    await verifyForcedTtyFollowRedraw(cliPath, outputRoot);

    process.stdout.write("tail probe: PASS\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await cleanupProbeWorkspaces(repoRoot);
  }
}

interface RunFixture {
  runId: string;
  logLines: string[];
  status: "running" | "success" | "failed" | "cancelled";
  phase:
    | "queued"
    | "starting"
    | "running"
    | "summarizing"
    | "completed"
    | "failed"
    | "cancelled";
  resultStatus: "running" | "success" | "failed" | "cancelled";
  exitCode: number | null;
  startedAt: string;
}

/** Creates one lightweight fixture run with log/status/result artifacts. */
async function createRunFixture(
  outputRoot: string,
  fixture: RunFixture,
): Promise<string> {
  const runDir = path.join(outputRoot, fixture.runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "run.log"),
    `${fixture.logLines.join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runDir, "status.json"),
    `${JSON.stringify(
      {
        runId: fixture.runId,
        agent: "codex",
        cwd: "/tmp/probe",
        taskSummary: "tail probe fixture",
        startedAt: fixture.startedAt,
        updatedAt: fixture.startedAt,
        finishedAt: fixture.status === "running" ? null : fixture.startedAt,
        phase: fixture.phase,
        summary: "fixture",
        status: fixture.status,
        resultState: fixture.status === "running" ? "pending" : fixture.status,
        logPath: path.join(runDir, "run.log"),
        resultPath: path.join(runDir, "result.json"),
        statusPath: path.join(runDir, "status.json"),
        summaryPath: path.join(runDir, "agent-summary.txt"),
        reportPath: path.join(runDir, "agent-report.json"),
        sessionId: null,
        resumedFromSessionId: null,
        pid: null,
        childPid: null,
        claimedAt: fixture.startedAt,
        terminationReason: null,
        stopRequestedAt: null,
        stopRequestedBy: null,
        lastProgressAt: fixture.startedAt,
        reporting: {
          lastReportAt: null,
          lastReportedPhase: null,
          reportCount: 0,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runDir, "result.json"),
    `${JSON.stringify(
      {
        runId: fixture.runId,
        agent: "codex",
        cwd: "/tmp/probe",
        taskSummary: "tail probe fixture",
        startedAt: fixture.startedAt,
        finishedAt:
          fixture.resultStatus === "running" ? null : fixture.startedAt,
        durationMinutes: fixture.resultStatus === "running" ? null : 0,
        exitCode: fixture.exitCode,
        status: fixture.resultStatus,
        logPath: path.join(runDir, "run.log"),
        resultPath: path.join(runDir, "result.json"),
        statusPath: path.join(runDir, "status.json"),
        summaryPath: path.join(runDir, "agent-summary.txt"),
        reportPath: path.join(runDir, "agent-report.json"),
        summary: "fixture",
        agentSummary: "fixture",
        validation: [],
        validationSummary: null,
        notes: null,
        commitId: null,
        sessionId: null,
        resumedFromSessionId: null,
        pid: null,
        childPid: null,
        claimedAt: fixture.startedAt,
        terminationReason: null,
        modifiedFiles: [],
        projectModifiedFiles: [],
        artifactFiles: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return path.join(runDir, "run.log");
}

/** Verifies wrapper lines are excluded by default before selecting the last N lines. */
function verifyDefaultWrapperExclusion(
  cliPath: string,
  outputRoot: string,
): void {
  const tailResult = spawnSync(
    process.execPath,
    [
      cliPath,
      "tail",
      "20260311100000-explicit-success",
      "-n",
      "2",
      "--output-root",
      outputRoot,
    ],
    { encoding: "utf8" },
  );

  assert.equal(tailResult.status, 0, tailResult.stderr || tailResult.stdout);
  assert.equal(
    tailResult.stdout,
    [
      "Run ID: 20260311100000-explicit-success",
      "Status: success (exit 0)",
      "",
      "alpha 2",
      "alpha 3",
      "",
    ].join("\n"),
  );
}

/** Verifies wrapper lines can be included again explicitly for debugging. */
function verifyExplicitIncludeWrapper(
  cliPath: string,
  outputRoot: string,
): void {
  const tailResult = spawnSync(
    process.execPath,
    [
      cliPath,
      "tail",
      "20260311100000-explicit-success",
      "-n",
      "2",
      "--include-wrapper",
      "--output-root",
      outputRoot,
    ],
    { encoding: "utf8" },
  );

  assert.equal(tailResult.status, 0, tailResult.stderr || tailResult.stdout);
  assert.equal(
    tailResult.stdout,
    [
      "Run ID: 20260311100000-explicit-success",
      "Status: success (exit 0)",
      "",
      "[wrapper] alpha wrapper 2",
      "alpha 3",
      "",
    ].join("\n"),
  );
}

/** Verifies the explicit exclusion flag matches the default hidden-wrapper behavior. */
function verifyExplicitExcludeWrapper(
  cliPath: string,
  outputRoot: string,
): void {
  const tailResult = spawnSync(
    process.execPath,
    [
      cliPath,
      "tail",
      "20260311100000-explicit-success",
      "-n",
      "2",
      "--exclude-wrapper",
      "--output-root",
      outputRoot,
    ],
    { encoding: "utf8" },
  );

  assert.equal(tailResult.status, 0, tailResult.stderr || tailResult.stdout);
  assert.match(tailResult.stdout, /alpha 2\nalpha 3\n$/);
  assert.doesNotMatch(tailResult.stdout, /\[wrapper\]/);
}

/** Verifies the implicit latest-run lookup prefers the newest running run. */
function verifyLatestRunning(cliPath: string, outputRoot: string): void {
  const tailResult = spawnSync(
    process.execPath,
    [cliPath, "tail", "-n", "1", "--output-root", outputRoot],
    { encoding: "utf8" },
  );

  assert.equal(tailResult.status, 0, tailResult.stderr || tailResult.stdout);
  assert.match(
    tailResult.stdout,
    /^Run ID: 20260311114500-wrapper-only-running\n/,
  );
  assert.match(tailResult.stdout, /Status: running\n\n/);
}

/** Verifies the implicit lookup falls back to the newest overall run when none run. */
async function verifyLatestOverallFallback(
  cliPath: string,
  workspace: string,
): Promise<void> {
  const fallbackRoot = path.join(workspace, "fallback-runs");
  await createRunFixture(fallbackRoot, {
    runId: "20260311140000-finished-earlier",
    logLines: ["delta 1"],
    status: "success",
    phase: "completed",
    resultStatus: "success",
    exitCode: 0,
    startedAt: "2026-03-11T14:00:00.000Z",
  });
  await createRunFixture(fallbackRoot, {
    runId: "20260311150000-finished-latest",
    logLines: ["epsilon 1", "[wrapper] epsilon 2"],
    status: "failed",
    phase: "failed",
    resultStatus: "failed",
    exitCode: 1,
    startedAt: "2026-03-11T15:00:00.000Z",
  });

  const tailResult = spawnSync(
    process.execPath,
    [cliPath, "tail", "-n", "1", "--output-root", fallbackRoot],
    { encoding: "utf8" },
  );

  assert.equal(tailResult.status, 0, tailResult.stderr || tailResult.stdout);
  assert.match(tailResult.stdout, /^Run ID: 20260311150000-finished-latest\n/);
  assert.match(tailResult.stdout, /Status: failed \(exit 1\)\n\n/);
  assert.match(tailResult.stdout, /epsilon 1\n$/);
}

/** Verifies non-TTY follow mode still appends visible lines without ANSI redraw codes. */
async function verifyNonTtyFollowAppend(
  cliPath: string,
  outputRoot: string,
): Promise<void> {
  const logPath = path.join(
    outputRoot,
    "20260311113000-latest-running",
    "run.log",
  );
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "tail",
      "20260311113000-latest-running",
      "-n",
      "1",
      "-f",
      "--output-root",
      outputRoot,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  await sleep(700);
  await appendFile(logPath, "[wrapper] beta wrapper 2\n", "utf8");
  await sleep(700);
  await appendFile(logPath, "beta 4\n", "utf8");
  await sleep(700);
  await appendFile(logPath, "[wrapper] beta wrapper 3\nbeta 5\n", "utf8");
  await sleep(500);
  child.kill("SIGINT");

  const exited = await waitForExit(child);

  assert.equal(exited, 0, stderr || stdout);
  assert.match(stdout, /^Run ID: 20260311113000-latest-running\n/);
  assert.match(stdout, /Status: running\n\n/);
  assert.match(stdout, /beta 3\n/);
  assert.match(stdout, /beta 4\n/);
  assert.match(stdout, /beta 5\n/);
  assert.equal(stdout.includes("\u001b["), false);
  assert.doesNotMatch(stdout, /beta wrapper 2|beta wrapper 3/);
}

/** Verifies forced TTY follow mode redraws a fixed region and shows the filtered placeholder. */
async function verifyForcedTtyFollowRedraw(
  cliPath: string,
  outputRoot: string,
): Promise<void> {
  const logPath = path.join(
    outputRoot,
    "20260311114500-wrapper-only-running",
    "run.log",
  );
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "tail",
      "20260311114500-wrapper-only-running",
      "-n",
      "2",
      "-f",
      "--output-root",
      outputRoot,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        [FORCE_TTY_ENV]: "1",
      },
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  await sleep(700);
  await appendFile(logPath, "[wrapper] hidden 3\n", "utf8");
  await sleep(700);
  await appendFile(logPath, "visible 1\n", "utf8");
  await sleep(700);
  child.kill("SIGINT");

  const exited = await waitForExit(child);

  assert.equal(exited, 0, stderr || stdout);
  assert.match(stdout, /^Run ID: 20260311114500-wrapper-only-running\n/);
  assert.match(stdout, /暂无可见日志；当前已隐藏 \[wrapper\] 行/u);
  assert.match(stdout, /visible 1\n/);
  assert.equal(stdout.includes("\u001b["), true);
  assert.equal(stdout.includes("\u001b[J"), true);
  assert.doesNotMatch(stdout, /hidden 1|hidden 2|hidden 3/);
}

/** Removes stale probe workspaces so repository lint does not pick them up later. */
async function cleanupProbeWorkspaces(repoRoot: string): Promise<void> {
  const entries = await readdir(repoRoot, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith(".probe-workspace-"),
      )
      .map((entry) =>
        rm(path.join(repoRoot, entry.name), { recursive: true, force: true }),
      ),
  );
}

/** Waits for one spawned child process to exit. */
async function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<number | null> {
  return await new Promise<number | null>((resolve, reject) => {
    child.on("exit", (code) => {
      resolve(code);
    });
    child.on("error", (error) => {
      reject(error);
    });
  });
}

/** Sleeps briefly while the probe waits for follow-mode output. */
async function sleep(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
