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

function buildWrappedTaskPrompt(options: CliOptions, context: RunContext): string {
  return `${options.task}\n\n---\nCompletion contract (required):\n1. Write a concise natural-language summary of completed work to: ${context.summaryPath}\n2. Write a JSON object to: ${context.reportPath}\n3. JSON schema:\n{\n  \"taskSummary\": string,\n  \"modifiedFiles\": string[],\n  \"projectModifiedFiles\": string[] | null,\n  \"artifactFiles\": string[] | null,\n  \"validation\": string[],\n  \"validationSummary\": string | null,\n  \"notes\": string | null,\n  \"commitId\": string | null\n}\n4. If this repository is managed by git and the coding task is successfully implemented + checked, you should create a git commit and put the new commit id into commitId.\n5. If the repo is not using git, or you intentionally did not commit, set commitId to null.\n6. Prefer projectModifiedFiles for actual project/worktree edits and artifactFiles for wrapper-generated artifacts such as agent-summary.txt or agent-report.json.\n7. If you only provide modifiedFiles, list only actual project/worktree edits there unless the task truly changed no project files.\n8. validationSummary should be a short single-line summary such as: \"build ✅, typecheck ✅\" when applicable.`;
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
  const wrappedPrompt = buildWrappedTaskPrompt(options, context);
  const args = resumeSessionId
    ? [
        "exec",
        "resume",
        resumeSessionId,
        wrappedPrompt,
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
        wrappedPrompt,
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
    reportFilePath: context.reportPath,
    resumedSessionId: resumeSessionId,
  };
}

/** Builds the initial Claude Code command shape for one task execution. */
async function buildClaudeLaunchSpec(
  options: CliOptions,
  context: RunContext,
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
        buildWrappedTaskPrompt(options, context),
      ]
    : [
        ...DEFAULT_CLAUDE_FLAGS,
        ...options.passthroughArgs,
        buildWrappedTaskPrompt(options, context),
      ];

  return {
    command,
    args,
    env: {
      ...process.env,
    },
    reportFilePath: context.reportPath,
    resumedSessionId: resumeSessionId,
  };
}

/** Ensures new agents are handled explicitly at compile time. */
function assertNever(agent: never): never {
  throw new Error(`Unsupported agent: ${String(agent)}`);
}
