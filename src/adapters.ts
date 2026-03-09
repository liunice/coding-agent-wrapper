/**
 * Builds lightweight command adapters for supported coding agents.
 * Important note: v1 favors a stable wrapper contract over deep agent-specific features.
 */

import type { AgentLaunchSpec, CliOptions, RunContext } from "./types";

/** Default flags for local Codex runs in externally sandboxed environments. */
const DEFAULT_CODEX_FLAGS = ["--dangerously-bypass-approvals-and-sandbox"];

/** Default flags for Claude Code non-interactive local runs. */
const DEFAULT_CLAUDE_FLAGS = [
  "-p",
  "--output-format",
  "json",
  "--permission-mode",
  "bypassPermissions",
  "--dangerously-skip-permissions",
];

/** Resolves a supported agent adapter into a concrete launch specification. */
export function createAgentLaunchSpec(
  options: CliOptions,
  context: RunContext,
): AgentLaunchSpec {
  switch (options.agent) {
    case "codex":
      return buildCodexLaunchSpec(options, context);
    case "claude":
      return buildClaudeLaunchSpec(options, context);
    default:
      return assertNever(options.agent);
  }
}

/** Builds the non-interactive Codex command for one task execution. */
function buildCodexLaunchSpec(
  options: CliOptions,
  context: RunContext,
): AgentLaunchSpec {
  const command = process.env.CODING_AGENT_WRAPPER_CODEX_BIN ?? "codex";
  const args = [
    "exec",
    "-C",
    options.cwd,
    "--skip-git-repo-check",
    "-o",
    context.summaryPath,
    ...DEFAULT_CODEX_FLAGS,
    ...options.passthroughArgs,
    options.task,
  ];

  return {
    command,
    args,
    env: {
      ...process.env,
      CODEX_API_KEY: "cli-proxy-api",
    },
    summaryFilePath: context.summaryPath,
  };
}

/** Builds the initial Claude Code command shape for one task execution. */
function buildClaudeLaunchSpec(
  options: CliOptions,
  _context: RunContext,
): AgentLaunchSpec {
  const command = process.env.CODING_AGENT_WRAPPER_CLAUDE_BIN ?? "claude";
  const args = [
    ...DEFAULT_CLAUDE_FLAGS,
    ...options.passthroughArgs,
    options.task,
  ];

  return {
    command,
    args,
    env: {
      ...process.env,
    },
  };
}

/** Ensures new agents are handled explicitly at compile time. */
function assertNever(agent: never): never {
  throw new Error(`Unsupported agent: ${String(agent)}`);
}
