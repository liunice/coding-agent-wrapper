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

let cachedSkillConfig: CodingAssistantSkillConfig | undefined;

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

  const resolvedEnv = resolveStringMap(rawSkillConfig.env, variableSources) ?? {};

  cachedSkillConfig = {
    env: resolvedEnv,
    notify: {
      channel:
        process.env.CODING_ASSISTANT_NOTIFY_CHANNEL ??
        resolvedEnv.CODING_ASSISTANT_NOTIFY_CHANNEL,
      target:
        process.env.CODING_ASSISTANT_NOTIFY_TARGET ??
        resolvedEnv.CODING_ASSISTANT_NOTIFY_TARGET,
      accountId:
        process.env.CODING_ASSISTANT_NOTIFY_ACCOUNT_ID ??
        resolvedEnv.CODING_ASSISTANT_NOTIFY_ACCOUNT_ID,
      replyTo:
        process.env.CODING_ASSISTANT_NOTIFY_REPLY_TO ??
        resolvedEnv.CODING_ASSISTANT_NOTIFY_REPLY_TO,
      threadId:
        process.env.CODING_ASSISTANT_NOTIFY_THREAD_ID ??
        resolvedEnv.CODING_ASSISTANT_NOTIFY_THREAD_ID,
      sessionKey:
        process.env.CODING_ASSISTANT_NOTIFY_SESSION_KEY ??
        resolvedEnv.CODING_ASSISTANT_NOTIFY_SESSION_KEY,
    },
  };

  return cachedSkillConfig;
}

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
      continue;
    }
  }

  return null;
}

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

function resolveTemplate(
  value: string,
  variables: Record<string, string | undefined>,
): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    return variables[name] ?? "";
  });
}
