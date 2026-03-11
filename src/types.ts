/**
 * Defines stable core types for the coding agent wrapper.
 * Important note: the result JSON is intentionally small and easy to consume.
 */

export type SupportedAgent = "codex" | "claude";

export type RunStatus = "running" | "success" | "failed";

export type RunPhase =
  | "queued"
  | "starting"
  | "running"
  | "summarizing"
  | "completed"
  | "failed"
  | "cancelled";

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
  progressEverySeconds?: number;
  progressStartAfterSeconds?: number;
  resumeMode: "auto" | "never";
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
  reportFilePath?: string;
  resumedSessionId?: string | null;
}

/** Stores resolved paths and timestamps for one wrapper execution. */
export interface RepoSnapshot {
  rootDir: string;
  headCommit: string | null;
  changedEntries: Record<string, string>;
}

/** Stores resolved paths and timestamps for one wrapper execution. */
export interface RunContext {
  runId: string;
  runDir: string;
  logPath: string;
  resultPath: string;
  statusPath: string;
  summaryPath: string;
  reportPath: string;
  startedAt: string;
  taskSummary: string;
  repoSnapshot: RepoSnapshot | null;
}

/** Defines the JSON artifact written for each run. */
export interface AgentReport {
  taskSummary?: string | null;
  modifiedFiles?: string[] | null;
  projectModifiedFiles?: string[] | null;
  artifactFiles?: string[] | null;
  validation?: string[] | null;
  validationSummary?: string | null;
  notes?: string | null;
  commitId?: string | null;
}

export interface RunResult {
  runId: string;
  agent: SupportedAgent;
  cwd: string;
  label?: string;
  taskSummary: string;
  startedAt: string;
  finishedAt: string | null;
  durationMinutes: number | null;
  exitCode: number | null;
  status: RunStatus;
  logPath: string;
  resultPath: string;
  statusPath: string;
  summaryPath: string;
  reportPath: string;
  summary: string;
  agentSummary: string;
  validation: string[];
  validationSummary: string | null;
  notes: string | null;
  commitId: string | null;
  sessionId: string | null;
  resumedFromSessionId: string | null;
  pid: number | null;
  claimedAt: string | null;
  terminationReason: string | null;
  modifiedFiles: string[];
  projectModifiedFiles: string[];
  artifactFiles: string[];
}

/** Describes the runtime ownership fields persisted into result.json. */
export interface RunRuntimeState {
  pid: number | null;
  claimedAt: string | null;
  terminationReason: string | null;
}

export interface RunReportingState {
  lastReportAt: string | null;
  lastReportedPhase: RunPhase | null;
  reportCount: number;
}

export interface RunStatusSnapshot {
  runId: string;
  agent: SupportedAgent;
  cwd: string;
  label?: string;
  taskSummary: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  phase: RunPhase;
  summary: string;
  status: RunStatus;
  resultState: "pending" | "success" | "failed";
  logPath: string;
  resultPath: string;
  statusPath: string;
  summaryPath: string;
  reportPath: string;
  sessionId: string | null;
  resumedFromSessionId: string | null;
  pid: number | null;
  claimedAt: string | null;
  terminationReason: string | null;
  lastProgressAt: string | null;
  reporting: RunReportingState;
}
