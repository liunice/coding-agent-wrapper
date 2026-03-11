/**
 * Verifies the wrapper-native tail command in normal and follow modes.
 * Important note: it uses temporary run.log files under a probe workspace and
 * does not depend on any external tail binary.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Runs the tail probe and prints a compact PASS message. */
async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..");
  await cleanupProbeWorkspaces(repoRoot);

  const workspace = path.resolve(
    repoRoot,
    `.probe-workspace-${process.pid}-${Date.now()}`,
  );
  const outputRoot = path.join(workspace, "runs");
  const runId = "probe-tail";
  const runDir = path.join(outputRoot, runId);
  const logPath = path.join(runDir, "run.log");
  const cliPath = path.resolve(__dirname, "cli.js");

  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(
      logPath,
      ["line 1", "line 2", "line 3", "line 4", ""].join("\n"),
      "utf8",
    );

    const tailResult = spawnSync(
      process.execPath,
      [cliPath, "tail", runId, "-n", "2", "--output-root", outputRoot],
      { encoding: "utf8" },
    );

    assert.equal(tailResult.status, 0, tailResult.stderr || tailResult.stdout);
    assert.equal(tailResult.stdout, "line 3\nline 4\n");

    const followResult = await runFollowProbe(
      cliPath,
      outputRoot,
      runId,
      logPath,
    );
    assert.equal(
      followResult,
      true,
      "follow mode should stream appended lines",
    );

    process.stdout.write("tail probe: PASS\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await cleanupProbeWorkspaces(repoRoot);
  }
}

/** Verifies `tail -f` outputs appended lines and exits cleanly on SIGINT. */
async function runFollowProbe(
  cliPath: string,
  outputRoot: string,
  runId: string,
  logPath: string,
): Promise<boolean> {
  const child = spawn(
    process.execPath,
    [cliPath, "tail", runId, "-n", "1", "-f", "--output-root", outputRoot],
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
  await appendFile(logPath, "line 5\n", "utf8");
  await sleep(700);
  await appendFile(logPath, "line 6\n", "utf8");

  const exited = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGINT");
    }, 1200);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    setTimeout(() => {
      child.kill("SIGINT");
    }, 300);
  });

  assert.equal(exited, 0, stderr || stdout);
  return (
    stdout.includes("line 4\n") &&
    stdout.includes("line 5\n") &&
    stdout.includes("line 6\n")
  );
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

/** Sleeps briefly while the probe waits for tail-follow output. */
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
