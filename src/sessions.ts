import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SupportedAgent } from "./types";

interface SessionIndexEntry {
  sessionId: string;
  updatedAt: string;
}

interface SessionIndex {
  entries: Record<string, SessionIndexEntry>;
}

export async function getResumeSessionId(
  outputRoot: string,
  agent: SupportedAgent,
  cwd: string,
): Promise<string | null> {
  const index = await readSessionIndex(outputRoot);
  return index.entries[buildSessionKey(agent, cwd)]?.sessionId ?? null;
}

export async function saveResumeSessionId(
  outputRoot: string,
  agent: SupportedAgent,
  cwd: string,
  sessionId: string,
): Promise<void> {
  const index = await readSessionIndex(outputRoot);
  index.entries[buildSessionKey(agent, cwd)] = {
    sessionId,
    updatedAt: new Date().toISOString(),
  };
  await writeSessionIndex(outputRoot, index);
}

function buildSessionKey(agent: SupportedAgent, cwd: string): string {
  return `${agent}::${path.resolve(cwd)}`;
}

async function readSessionIndex(outputRoot: string): Promise<SessionIndex> {
  const filePath = getSessionIndexPath(outputRoot);
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as SessionIndex;
    return {
      entries: parsed.entries ?? {},
    };
  } catch {
    return { entries: {} };
  }
}

async function writeSessionIndex(
  outputRoot: string,
  index: SessionIndex,
): Promise<void> {
  const filePath = getSessionIndexPath(outputRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function getSessionIndexPath(outputRoot: string): string {
  return path.resolve(outputRoot, "session-index.json");
}
