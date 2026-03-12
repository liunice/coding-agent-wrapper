/**
 * Persists the latest agent-originated activity for progress reporting.
 * Important note: this sidecar file keeps Claude progress separate from wrapper logs.
 */

import { readFile, writeFile } from "node:fs/promises";

import type { AgentActivitySnapshot } from "./types";

/** Writes the latest agent activity snapshot for one run. */
export async function writeAgentActivity(
  filePath: string,
  activity: AgentActivitySnapshot,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(activity, null, 2)}\n`, "utf8");
}

/** Reads the latest agent activity snapshot when it exists. */
export async function readAgentActivity(
  filePath: string,
): Promise<AgentActivitySnapshot | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as AgentActivitySnapshot;
  } catch {
    return null;
  }
}
