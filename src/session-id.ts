/**
 * Centralizes session id extraction for supported agents.
 * Important note: streaming detection keeps a small rolling window so early ids
 * survive long-output runs without holding the entire log in memory.
 */

import type { SupportedAgent } from "./types";

/** Keeps enough recent text to match split session-id lines across chunks. */
const MAX_SESSION_SCAN_WINDOW = 8 * 1024;

/** Stores rolling state for stream-time session id detection. */
export interface SessionDetectionState {
  recentOutput: string;
  sessionId: string | null;
}

/** Creates an empty session detection state for one child process. */
export function createSessionDetectionState(): SessionDetectionState {
  return {
    recentOutput: "",
    sessionId: null,
  };
}

/**
 * Feeds new child output into the detector and caches the first discovered
 * session id so later truncation cannot lose it.
 */
export function detectSessionIdFromStream(
  agent: SupportedAgent,
  state: SessionDetectionState,
  text: string,
): string | null {
  if (state.sessionId || !text) {
    return state.sessionId;
  }

  state.recentOutput = appendRecentOutput(state.recentOutput, text);
  state.sessionId = extractSessionId(agent, state.recentOutput);
  return state.sessionId;
}

/** Extracts a session id from arbitrary text emitted by a supported agent. */
export function extractSessionId(
  agent: SupportedAgent,
  output: string,
): string | null {
  if (!output.trim()) {
    return null;
  }

  if (agent === "codex") {
    const match = output.match(/session id:\s*([0-9a-f-]{36})/i);
    return match?.[1] ?? null;
  }

  if (agent === "claude") {
    for (const line of output.split(/\r?\n/).reverse()) {
      try {
        const parsed = JSON.parse(line) as { session_id?: unknown };
        if (typeof parsed.session_id === "string" && parsed.session_id.trim()) {
          return parsed.session_id;
        }
      } catch {
        // Ignore non-JSON lines while scanning Claude output.
      }
    }
  }

  return null;
}

/** Keeps only a small tail window for chunk-boundary-safe stream scanning. */
function appendRecentOutput(current: string, next: string): string {
  const merged = `${current}${next}`;
  if (merged.length <= MAX_SESSION_SCAN_WINDOW) {
    return merged;
  }
  return merged.slice(-MAX_SESSION_SCAN_WINDOW);
}
