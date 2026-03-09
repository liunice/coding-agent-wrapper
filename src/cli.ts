#!/usr/bin/env node
/**
 * Provides the main CLI entry point for the coding agent wrapper.
 * Important note: this file keeps parsing intentionally simple and dependency-light.
 */

import path from "node:path";
import process from "node:process";

import { createRunContext, executeRun, launchDetached } from "./runner";
import type { CliOptions, SupportedAgent } from "./types";

/** Supported agent names accepted by the CLI. */
const SUPPORTED_AGENTS: SupportedAgent[] = ["codex", "claude"];

/** Bootstraps the CLI and exits with the appropriate status code. */
async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  if (!options) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const context = await createRunContext(options);

  if (options.detach && !options.internalRun) {
    await launchDetached(options, context);
    process.stdout.write(
      `${JSON.stringify(
        {
          runId: context.runId,
          status: "running",
          logPath: context.logPath,
          resultPath: context.resultPath,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const exitCode = await executeRun(options, context);
  process.exitCode = exitCode;
}

/** Parses CLI arguments into a small normalized options object. */
function parseCliArgs(argv: string[]): CliOptions | null {
  const args = [...argv];

  if (args[0] === "run") {
    args.shift();
  }

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return null;
  }

  let agent: SupportedAgent | undefined;
  let cwd: string | undefined;
  let task: string | undefined;
  let label: string | undefined;
  let outputRoot = path.resolve(process.cwd(), "runs");
  let detach = false;
  let internalRun = false;
  let runId: string | undefined;
  let startedAt: string | undefined;
  let resumeMode: "auto" | "never" = "auto";
  let notifySessionKey: string | undefined;
  let notifyChannel: string | undefined;
  let notifyTarget: string | undefined;
  let notifyAccount: string | undefined;
  let notifyReplyTo: string | undefined;
  let notifyThreadId: string | undefined;
  const passthroughArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if (value === "--") {
      passthroughArgs.push(...args.slice(index + 1));
      break;
    }

    switch (value) {
      case "--agent":
        agent = readAgent(args[++index]);
        break;
      case "--cwd":
        cwd = path.resolve(readRequiredValue(value, args[++index]));
        break;
      case "--task":
        task = readRequiredValue(value, args[++index]);
        break;
      case "--label":
        label = readRequiredValue(value, args[++index]);
        break;
      case "--output-root":
        outputRoot = path.resolve(readRequiredValue(value, args[++index]));
        break;
      case "--run-id":
        runId = readRequiredValue(value, args[++index]);
        break;
      case "--started-at":
        startedAt = readRequiredValue(value, args[++index]);
        break;
      case "--new-session":
        resumeMode = "never";
        break;
      case "--notify-session-key":
        notifySessionKey = readRequiredValue(value, args[++index]);
        break;
      case "--notify-channel":
        notifyChannel = readRequiredValue(value, args[++index]);
        break;
      case "--notify-target":
        notifyTarget = readRequiredValue(value, args[++index]);
        break;
      case "--notify-account":
        notifyAccount = readRequiredValue(value, args[++index]);
        break;
      case "--notify-reply-to":
        notifyReplyTo = readRequiredValue(value, args[++index]);
        break;
      case "--notify-thread-id":
        notifyThreadId = readRequiredValue(value, args[++index]);
        break;
      case "--detach":
        detach = true;
        break;
      case "--internal-run":
        internalRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!agent || !cwd || !task) {
    return null;
  }

  if (
    (notifyChannel || notifyAccount || notifyReplyTo || notifyThreadId) &&
    !notifyTarget
  ) {
    throw new Error(
      "--notify-target is required when using notify delivery flags",
    );
  }

  return {
    agent,
    cwd,
    task,
    label,
    detach,
    outputRoot,
    internalRun,
    runId,
    startedAt,
    resumeMode,
    notifySessionKey,
    notifyChannel,
    notifyTarget,
    notifyAccount,
    notifyReplyTo,
    notifyThreadId,
    passthroughArgs,
  };
}

/** Validates the requested agent against the supported list. */
function readAgent(value: string | undefined): SupportedAgent {
  const agent = readRequiredValue("--agent", value);
  if (!SUPPORTED_AGENTS.includes(agent as SupportedAgent)) {
    throw new Error(`Unsupported agent: ${agent}`);
  }
  return agent as SupportedAgent;
}

/** Ensures a required flag value exists before it is consumed. */
function readRequiredValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

/** Prints the short usage guide for the wrapper CLI. */
function printUsage(): void {
  process.stdout.write(
    "coding-agent-wrapper\n\nUsage:\n  node dist/cli.js run --agent <codex|claude> --cwd <path> --task <text> [--label <text>] [--detach] [--new-session] [--output-root <path>] [--notify-session-key <key>] [--notify-channel <name> --notify-target <id> [--notify-account <id>] [--notify-reply-to <id>] [--notify-thread-id <id>]] [-- ...passthrough]\n",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
