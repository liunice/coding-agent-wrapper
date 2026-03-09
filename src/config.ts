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
  env?: {
    vars?: Record<string, string>;
  };
  skills?: {
    entries?: Record<string, CodingAssistantSkillConfig | undefined>;
  };
}

/** Caches the resolved skill config to avoid repeated disk reads. */
let cachedSkillConfig: CodingAssistantSkillConfig | undefined;

/** Returns the merged coding-assistant config with env overrides applied. */
export function getCodingAssistantSkillConfig(): CodingAssistantSkillConfig {
  if (cachedSkillConfig !== undefined) {
    return cachedSkillConfig ?? {};
  }

  const config = loadOpenClawConfig();
  const rawSkillConfig = config?.skills?.entries?.["coding-assistant"] ?? {};
  const variableSources = {
    ...(config?.env?.vars ?? {}),
    ...process.env,
  };

  const resolvedEnv =
    resolveStringMap(rawSkillConfig.env, variableSources) ?? {};

  cachedSkillConfig = {
    env: resolvedEnv,
    notify: {
      channel: process.env.NOTIFY_CHANNEL ?? resolvedEnv.NOTIFY_CHANNEL,
      target: process.env.NOTIFY_TARGET ?? resolvedEnv.NOTIFY_TARGET,
      accountId: process.env.NOTIFY_ACCOUNT_ID ?? resolvedEnv.NOTIFY_ACCOUNT_ID,
      replyTo: process.env.NOTIFY_REPLY_TO ?? resolvedEnv.NOTIFY_REPLY_TO,
      threadId: process.env.NOTIFY_THREAD_ID ?? resolvedEnv.NOTIFY_THREAD_ID,
      sessionKey:
        process.env.NOTIFY_SESSION_KEY ?? resolvedEnv.NOTIFY_SESSION_KEY,
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

/** Resolves a string map with ${VAR} templates against known variables. */
function resolveStringMap(
  value: Record<string, string> | undefined,
  variables: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    result[key] = resolveTemplate(raw, variables);
  }
  return result;
}

/** Replaces ${VAR} placeholders with resolved environment values. */
function resolveTemplate(
  value: string,
  variables: Record<string, string | undefined>,
): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    return variables[name] ?? "";
  });
}
