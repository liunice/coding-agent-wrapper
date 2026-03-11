import { spawn } from "node:child_process";
import { constants, accessSync } from "node:fs";
import path from "node:path";

import { getCodingAssistantSkillConfig } from "./config";
import type { RunCliOptions } from "./types";

interface NotifyAttempt {
  name: string;
  args: string[];
}

export async function sendProgressNotification(
  options: RunCliOptions,
  text: string,
  log: (line: string) => void,
): Promise<boolean> {
  return await sendNotification(options, text, log, "progress");
}

export async function sendCompletionNotification(
  options: RunCliOptions,
  text: string,
  log: (line: string) => void,
): Promise<boolean> {
  return await sendNotification(options, text, log, "completion");
}

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

  for (const attempt of attempts) {
    log(
      `[wrapper] ${kind}-notify attempt=${attempt.name} command=${renderCommand(command, attempt.args)}`,
    );
    const result = await runNotifyAttempt(command, attempt.args, log, kind);
    if (result === 0) {
      return true;
    }
  }

  return false;
}

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

    attempts.push({ name: "message-send", args });
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

async function runNotifyAttempt(
  command: string,
  args: string[],
  log: (line: string) => void,
  kind: "progress" | "completion",
): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      env: process.env,
    });

    child.on("close", (code) => {
      log(`[wrapper] ${kind}-notify exit=${code ?? "null"}`);
      resolve(code ?? null);
    });

    child.on("error", (error) => {
      log(`[wrapper] ${kind}-notify error=${error.message}`);
      resolve(null);
    });
  });
}

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
      // keep searching
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
      // keep searching
    }
  }

  return null;
}

function renderCommand(command: string, args: string[]): string {
  return [command, ...args.map(quoteArgument)].join(" ");
}

function quoteArgument(value: string): string {
  return /[^A-Za-z0-9_./:-]/.test(value) ? JSON.stringify(value) : value;
}
