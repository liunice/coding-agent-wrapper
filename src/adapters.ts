/**
 * Builds lightweight command adapters for supported coding agents.
 * Important note: v1 favors a stable wrapper contract over deep agent-specific features.
 */

import { getCodingAssistantSkillConfig } from "./config";
import { getResumeSessionId } from "./sessions";
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
export async function createAgentLaunchSpec(
  options: CliOptions,
  context: RunContext,
): Promise<AgentLaunchSpec> {
  switch (options.agent) {
    case "codex":
      return await buildCodexLaunchSpec(options, context);
    case "claude":
      return await buildClaudeLaunchSpec(options, context);
    default:
      return assertNever(options.agent);
  }
}

/** Builds the non-interactive Codex command for one task execution. */
async function buildCodexLaunchSpec(
  options: CliOptions,
  context: RunContext,
): Promise<AgentLaunchSpec> {
  const command = process.env.CODING_AGENT_WRAPPER_CODEX_BIN ?? "codex";
  const resumeSessionId =
    options.resumeMode === "auto"
      ? await getResumeSessionId(options.outputRoot, options.agent, options.cwd)
      : null;
  const args = resumeSessionId
    ? [
        "exec",
        "resume",
        resumeSessionId,
        options.task,
        "-o",
        context.summaryPath,
        ...DEFAULT_CODEX_FLAGS,
        ...options.passthroughArgs,
      ]
    : [
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

  const skillEnv = getCodingAssistantSkillConfig().env ?? {};
  const env = {
    ...process.env,
    ...skillEnv,
  };

  if (!env.CODEX_API_KEY) {
    throw new Error(
      "Missing CODEX_API_KEY. Set it in the runtime environment or openclaw.json -> skills.entries.coding-assistant.env.CODEX_API_KEY.",
    );
  }

  return {
    command,
    args,
    env,
    summaryFilePath: context.summaryPath,
    resumedSessionId: resumeSessionId,
  };
}

/** Builds the initial Claude Code command shape for one task execution. */
async function buildClaudeLaunchSpec(
  options: CliOptions,
  _context: RunContext,
): Promise<AgentLaunchSpec> {
  const command = process.env.CODING_AGENT_WRAPPER_CLAUDE_BIN ?? "claude";
  const resumeSessionId =
    options.resumeMode === "auto"
      ? await getResumeSessionId(options.outputRoot, options.agent, options.cwd)
      : null;
  const args = resumeSessionId
    ? [
        ...DEFAULT_CLAUDE_FLAGS,
        "-r",
        resumeSessionId,
        ...options.passthroughArgs,
        options.task,
      ]
    : [
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
    resumedSessionId: resumeSessionId,
  };
}

/** Ensures new agents are handled explicitly at compile time. */
function assertNever(agent: never): never {
  throw new Error(`Unsupported agent: ${String(agent)}`);
}
