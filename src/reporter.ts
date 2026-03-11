/**
 * Sends wrapper notifications through OpenClaw provider channels and sessions.
 * Important note: when both explicit channel routing and a session key exist,
 * provider delivery always runs first and session injection runs afterwards.
 */

import { spawn } from "node:child_process";
import { constants, accessSync } from "node:fs";
import path from "node:path";

import { getCodingAssistantSkillConfig } from "./config";
import type { RunCliOptions } from "./types";

/** Describes one concrete OpenClaw notify invocation. */
interface NotifyAttempt {
  name: string;
  args: string[];
}

/** Sends one wrapper-controlled progress notification. */
export async function sendProgressNotification(
  options: RunCliOptions,
  text: string,
  log: (line: string) => void,
): Promise<boolean> {
  return await sendNotification(options, text, log, "progress");
}

/** Sends one wrapper-controlled completion notification. */
export async function sendCompletionNotification(
  options: RunCliOptions,
  text: string,
  log: (line: string) => void,
): Promise<boolean> {
  return await sendNotification(options, text, log, "completion");
}

/** Executes all configured notify attempts in a stable order and reports success. */
async function sendNotification(
  options: RunCliOptions,
  text: string,
  log: (line: string) => void,
  kind: "progress" | "completion",
): Promise<boolean> {
  const openclawPath = resolveOpenClawBinary();
  const command = openclawPath ?? "openclaw";
  const attempts = buildNotifyAttempts(options, text);

  if (attempts.length === 0) {
    log(`[wrapper] ${kind}-notify skipped=no-target`);
    return false;
  }

  let anySuccess = false;
  for (const [index, attempt] of attempts.entries()) {
    log(
      `[wrapper] ${kind}-notify step=${index + 1}/${attempts.length} attempt=${attempt.name} command=${renderCommand(command, attempt.args)}`,
    );
    const result = await runNotifyAttempt(command, attempt, log, kind);
    if (result === 0) {
      anySuccess = true;
    }
  }

  log(
    `[wrapper] ${kind}-notify finished success=${String(anySuccess)} attempted=${attempts.length}`,
  );
  return anySuccess;
}

/** Builds the ordered notification attempts for the current run. */
function buildNotifyAttempts(
  options: RunCliOptions,
  text: string,
): NotifyAttempt[] {
  const attempts: NotifyAttempt[] = [];
  const skillNotify = getCodingAssistantSkillConfig().notify ?? {};
  const notifyChannel = options.notifyChannel ?? skillNotify.channel;
  const notifyTarget = options.notifyTarget ?? skillNotify.target;
  const notifyAccount = options.notifyAccount ?? skillNotify.accountId;
  const notifyReplyTo = options.notifyReplyTo ?? skillNotify.replyTo;
  const notifyThreadId = options.notifyThreadId ?? skillNotify.threadId;
  const notifySessionKey = options.notifySessionKey ?? skillNotify.sessionKey;

  if (notifyTarget) {
    const args = [
      "message",
      "send",
      "--target",
      notifyTarget,
      "--message",
      text,
    ];

    if (notifyChannel) {
      args.push("--channel", notifyChannel);
    }
    if (notifyAccount) {
      args.push("--account", notifyAccount);
    }
    if (notifyReplyTo) {
      args.push("--reply-to", notifyReplyTo);
    }
    if (notifyThreadId) {
      args.push("--thread-id", notifyThreadId);
    }

    attempts.push({
      name: "message-send",
      args,
    });
  }

  if (notifySessionKey) {
    const params = {
      sessionKey: notifySessionKey,
      message: text,
      label: "coding-agent-wrapper",
    };

    attempts.push({
      name: "chat-inject",
      args: [
        "gateway",
        "call",
        "chat.inject",
        "--params",
        JSON.stringify(params),
        "--timeout",
        "10000",
      ],
    });
  }

  if (attempts.length === 0) {
    attempts.push({
      name: "system-event",
      args: ["system", "event", "--text", text, "--mode", "now"],
    });
  }

  return attempts;
}

/** Runs one notify attempt and records its individual result in the wrapper log. */
async function runNotifyAttempt(
  command: string,
  attempt: NotifyAttempt,
  log: (line: string) => void,
  kind: "progress" | "completion",
): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const child = spawn(command, attempt.args, {
      stdio: "ignore",
      env: process.env,
    });

    child.on("close", (code) => {
      log(
        `[wrapper] ${kind}-notify result=${attempt.name} exit=${code ?? "null"} success=${String(code === 0)}`,
      );
      resolve(code ?? null);
    });

    child.on("error", (error) => {
      log(
        `[wrapper] ${kind}-notify result=${attempt.name} error=${error.message} success=false`,
      );
      resolve(null);
    });
  });
}

/** Resolves an absolute OpenClaw binary path when PATH inheritance is unreliable. */
function resolveOpenClawBinary(): string | null {
  const candidates = [
    process.env.OPENCLAW_BIN,
    process.env.npm_config_prefix
      ? path.join(process.env.npm_config_prefix, "bin", "openclaw")
      : null,
    process.env.HOME
      ? path.join(process.env.HOME, ".npm-global/bin/openclaw")
      : null,
    "/volume1/homes/liunice/.npm-global/bin/openclaw",
    "/usr/local/bin/openclaw",
    "/usr/bin/openclaw",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching.
    }
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, "openclaw");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching.
    }
  }

  return null;
}

/** Renders a shell-like command string for logs and debugging. */
function renderCommand(command: string, args: string[]): string {
  return [command, ...args.map(quoteArgument)].join(" ");
}

/** Applies simple shell-safe quoting for human-readable logs. */
function quoteArgument(value: string): string {
  return /[^A-Za-z0-9_./:-]/.test(value) ? JSON.stringify(value) : value;
}
