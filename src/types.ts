/**
 * Defines stable core types for the coding agent wrapper.
 * Important note: the result JSON is intentionally small and easy to consume.
 */

export type SupportedAgent = "codex" | "claude";

export type RunStatus = "running" | "success" | "failed";

/** Describes CLI options after parsing and normalization. */
export interface CliOptions {
  agent: SupportedAgent;
  cwd: string;
  task: string;
  label?: string;
  detach: boolean;
  outputRoot: string;
  internalRun: boolean;
  runId?: string;
  startedAt?: string;
  notifySessionKey?: string;
  notifyChannel?: string;
  notifyTarget?: string;
  notifyAccount?: string;
  notifyReplyTo?: string;
  notifyThreadId?: string;
  passthroughArgs: string[];
}

/** Describes the launch shape that each agent adapter must provide. */
export interface AgentLaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  summaryFilePath?: string;
}

/** Stores resolved paths and timestamps for one wrapper execution. */
export interface RunContext {
  runId: string;
  runDir: string;
  logPath: string;
  resultPath: string;
  summaryPath: string;
  startedAt: string;
  taskSummary: string;
}

/** Defines the JSON artifact written for each run. */
export interface RunResult {
  runId: string;
  agent: SupportedAgent;
  cwd: string;
  label?: string;
  taskSummary: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  status: RunStatus;
  logPath: string;
  summary: string;
}
