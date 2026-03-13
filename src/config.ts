/**
 * Loads coding-assistant wrapper configuration from OpenClaw config and env.
 * Important note: invalid config files are ignored so direct env usage still works.
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface CodingAssistantNotifyConfig {
  channel?: string;
  target?: string;
  accountId?: string;
  replyTo?: string;
  threadId?: string;
  sessionKey?: string;
}

interface CodingAssistantSkillConfig {
  env?: Record<string, string>;
  notify?: CodingAssistantNotifyConfig;
}

interface OpenClawConfigShape {
  skills?: {
    entries?: Record<string, CodingAssistantSkillConfig | undefined>;
  };
}

/** Caches the resolved skill config to avoid repeated disk reads. */
let cachedSkillConfig: CodingAssistantSkillConfig | undefined;

/** Returns coding-assistant config used for non-secret notification defaults only. */
export function getCodingAssistantSkillConfig(): CodingAssistantSkillConfig {
  if (cachedSkillConfig !== undefined) {
    return cachedSkillConfig ?? {};
  }

  const config = loadOpenClawConfig();
  const rawSkillConfig = config?.skills?.entries?.["coding-assistant"] ?? {};
  const configuredEnv = rawSkillConfig.env ?? {};

  cachedSkillConfig = {
    env: configuredEnv,
    notify: {
      channel: process.env.NOTIFY_CHANNEL ?? configuredEnv.NOTIFY_CHANNEL,
      target: process.env.NOTIFY_TARGET ?? configuredEnv.NOTIFY_TARGET,
      accountId: process.env.NOTIFY_ACCOUNT_ID ?? configuredEnv.NOTIFY_ACCOUNT_ID,
      replyTo: process.env.NOTIFY_REPLY_TO ?? configuredEnv.NOTIFY_REPLY_TO,
      threadId: process.env.NOTIFY_THREAD_ID ?? configuredEnv.NOTIFY_THREAD_ID,
      sessionKey:
        process.env.NOTIFY_SESSION_KEY ?? configuredEnv.NOTIFY_SESSION_KEY,
    },
  };

  return cachedSkillConfig;
}

/** Loads the first readable OpenClaw config file from known locations. */
function loadOpenClawConfig(): OpenClawConfigShape | null {
  const candidates = [
    process.env.OPENCLAW_CONFIG_PATH,
    path.join(os.homedir(), ".openclaw", "openclaw.json"),
    "/volume1/Videos/Docker/OpenClaw/openclaw.json",
  ].filter((value): value is string => Boolean(value));

  for (const filePath of candidates) {
    if (!existsSync(filePath)) {
      continue;
    }

    try {
      return JSON.parse(readFileSync(filePath, "utf8")) as OpenClawConfigShape;
    } catch {
      // Try the next candidate file.
    }
  }

  return null;
}

