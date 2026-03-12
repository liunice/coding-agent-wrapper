#!/usr/bin/env node
/**
 * Provides the main CLI entry point for the coding agent wrapper.
 * Important note: this file keeps parsing intentionally simple and dependency-light.
 */

import path from "node:path";
import process from "node:process";

import { listActiveRuns, showRun } from "./query";
import { createRunContext, executeRun, launchDetached } from "./runner";
import { stopRun } from "./stop";
import { tailRunLog } from "./tail";
import type {
  CliOptions,
  RunCliOptions,
  RunsCliOptions,
  ShowCliOptions,
  StopCliOptions,
  SupportedAgent,
  TailCliOptions,
} from "./types";

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

  if (options.command === "stop") {
    process.exitCode = await stopRun(options);
    return;
  }

  if (options.command === "runs") {
    process.exitCode = await listActiveRuns(options);
    return;
  }

  if (options.command === "show") {
    process.exitCode = await showRun(options);
    return;
  }

  if (options.command === "tail") {
    process.exitCode = await tailRunLog(options);
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

  let command: "run" | "stop" | "runs" | "show" | "tail" = "run";
  if (
    args[0] === "run" ||
    args[0] === "stop" ||
    args[0] === "runs" ||
    args[0] === "show" ||
    args[0] === "tail"
  ) {
    command = args[0] as "run" | "stop" | "runs" | "show" | "tail";
    args.shift();
  }

  if (args.includes("--help") || args.includes("-h")) {
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
  let progressEverySeconds: number | undefined;
  let progressStartAfterSeconds: number | undefined;
  let resumeMode: "auto" | "never" = "auto";
  let notifySessionKey: string | undefined;
  let notifyChannel: string | undefined;
  let notifyTarget: string | undefined;
  let notifyAccount: string | undefined;
  let notifyReplyTo: string | undefined;
  let notifyThreadId: string | undefined;
  let tailLines = 10;
  let follow = false;
  let includeWrapper = false;
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
      case "--progress-every-seconds":
        progressEverySeconds = Number.parseInt(
          readRequiredValue(value, args[++index]),
          10,
        );
        if (
          !Number.isFinite(progressEverySeconds) ||
          progressEverySeconds <= 0
        ) {
          throw new Error(
            "--progress-every-seconds must be a positive integer",
          );
        }
        break;
      case "--progress-start-after-seconds":
        progressStartAfterSeconds = Number.parseInt(
          readRequiredValue(value, args[++index]),
          10,
        );
        if (
          !Number.isFinite(progressStartAfterSeconds) ||
          progressStartAfterSeconds < 0
        ) {
          throw new Error(
            "--progress-start-after-seconds must be a non-negative integer",
          );
        }
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
      case "-n":
      case "--lines":
        tailLines = Number.parseInt(
          readRequiredValue(value, args[++index]),
          10,
        );
        if (!Number.isFinite(tailLines) || tailLines <= 0) {
          throw new Error("--lines must be a positive integer");
        }
        break;
      case "-f":
      case "--follow":
        follow = true;
        break;
      case "--include-wrapper":
        includeWrapper = true;
        break;
      case "--exclude-wrapper":
        includeWrapper = false;
        break;
      case "--detach":
        detach = true;
        break;
      case "--internal-run":
        internalRun = true;
        break;
      default:
        if (command === "tail" && !runId && !value.startsWith("-")) {
          runId = value;
          break;
        }
        throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (command === "run" && (!agent || !cwd || !task)) {
    return null;
  }

  if ((command === "stop" || command === "show") && !runId) {
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

  if (command === "stop") {
    if (!runId) {
      return null;
    }

    const options: StopCliOptions = {
      command,
      runId,
      label,
      detach,
      outputRoot,
      internalRun,
      startedAt,
      progressEverySeconds,
      progressStartAfterSeconds,
      resumeMode,
      notifySessionKey,
      notifyChannel,
      notifyTarget,
      notifyAccount,
      notifyReplyTo,
      notifyThreadId,
      passthroughArgs,
    };
    return options;
  }

  if (command === "runs") {
    const options: RunsCliOptions = {
      command,
      label,
      detach,
      outputRoot,
      internalRun,
      runId,
      startedAt,
      progressEverySeconds,
      progressStartAfterSeconds,
      resumeMode,
      notifySessionKey,
      notifyChannel,
      notifyTarget,
      notifyAccount,
      notifyReplyTo,
      notifyThreadId,
      passthroughArgs,
    };
    return options;
  }

  if (command === "show") {
    if (!runId) {
      return null;
    }

    const options: ShowCliOptions = {
      command,
      runId,
      label,
      detach,
      outputRoot,
      internalRun,
      startedAt,
      progressEverySeconds,
      progressStartAfterSeconds,
      resumeMode,
      notifySessionKey,
      notifyChannel,
      notifyTarget,
      notifyAccount,
      notifyReplyTo,
      notifyThreadId,
      passthroughArgs,
    };
    return options;
  }

  if (command === "tail") {
    const options: TailCliOptions = {
      command,
      runId,
      lines: tailLines,
      follow,
      includeWrapper,
      label,
      detach,
      outputRoot,
      internalRun,
      startedAt,
      progressEverySeconds,
      progressStartAfterSeconds,
      resumeMode,
      notifySessionKey,
      notifyChannel,
      notifyTarget,
      notifyAccount,
      notifyReplyTo,
      notifyThreadId,
      passthroughArgs,
    };
    return options;
  }

  if (!agent || !cwd || !task) {
    return null;
  }

  const options: RunCliOptions = {
    command,
    agent,
    cwd,
    task,
    label,
    detach,
    outputRoot,
    internalRun,
    runId,
    startedAt,
    progressEverySeconds,
    progressStartAfterSeconds,
    resumeMode,
    notifySessionKey,
    notifyChannel,
    notifyTarget,
    notifyAccount,
    notifyReplyTo,
    notifyThreadId,
    passthroughArgs,
  };
  return options;
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
    "coding-agent-wrapper\n\nUsage:\n  node dist/cli.js run --agent <codex|claude> --cwd <path> --task <text> [--label <text>] [--detach] [--new-session] [--progress-every-seconds <n>] [--progress-start-after-seconds <n>] [--output-root <path>] [--notify-session-key <key>] [--notify-channel <name> --notify-target <id> [--notify-account <id>] [--notify-reply-to <id>] [--notify-thread-id <id>]] [-- ...passthrough]\n  node dist/cli.js stop --run-id <id> [--output-root <path>]\n  node dist/cli.js runs [--output-root <path>]\n  node dist/cli.js show --run-id <id> [--output-root <path>]\n  node dist/cli.js tail [run-id] [-n <count>] [-f] [--include-wrapper|--exclude-wrapper] [--output-root <path>]\n",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
