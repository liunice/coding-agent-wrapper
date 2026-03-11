import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { readRunStatus } from "./status";
import type { RunsCliOptions, ShowCliOptions, SupportedAgent } from "./types";

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

export async function listActiveRuns(options: RunsCliOptions): Promise<number> {
  const activeRunsDir = path.resolve(options.outputRoot, "active-runs");
  let entries: string[] = [];

  try {
    entries = await readdir(activeRunsDir);
  } catch {
    process.stdout.write(`${JSON.stringify({ activeRuns: [] }, null, 2)}\n`);
    return 0;
  }

  const runs = [] as Array<Record<string, unknown>>;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const claimPath = path.join(activeRunsDir, entry);
    const claim = await readActiveClaim(claimPath);
    if (!claim) {
      continue;
    }

    const statusPath = path.resolve(
      options.outputRoot,
      claim.runId,
      "status.json",
    );
    const status = await readRunStatus(statusPath);
    runs.push({
      runId: claim.runId,
      agent: claim.agent,
      cwd: claim.cwd,
      startedAt: claim.startedAt,
      claimedAt: claim.claimedAt,
      pid: claim.pid,
      status: status?.status ?? "running",
      phase: status?.phase ?? "running",
      summary: status?.summary ?? null,
      statusPath,
    });
  }

  process.stdout.write(`${JSON.stringify({ activeRuns: runs }, null, 2)}\n`);
  return 0;
}

export async function showRun(options: ShowCliOptions): Promise<number> {
  const runDir = path.resolve(options.outputRoot, options.runId);
  const statusPath = path.join(runDir, "status.json");
  const resultPath = path.join(runDir, "result.json");
  const status = await readRunStatus(statusPath);
  const result = await readJsonFile(resultPath);

  if (!status && !result) {
    throw new Error(`Run not found: ${options.runId}`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        runId: options.runId,
        status: status ?? null,
        result: result ?? null,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function readActiveClaim(
  claimPath: string,
): Promise<ActiveRunClaimRecord | null> {
  try {
    const content = await readFile(claimPath, "utf8");
    return JSON.parse(content) as ActiveRunClaimRecord;
  } catch {
    return null;
  }
}

async function readJsonFile(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}
