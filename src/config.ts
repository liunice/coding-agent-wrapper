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

let cachedSkillConfig: CodingAssistantSkillConfig | null | undefined;

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

  cachedSkillConfig = {
    env: resolveStringMap(rawSkillConfig.env, variableSources),
    notify: resolveNotifyConfig(rawSkillConfig.notify, variableSources),
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

function resolveNotifyConfig(
  value: CodingAssistantNotifyConfig | undefined,
  variables: Record<string, string | undefined>,
): CodingAssistantNotifyConfig | undefined {
  if (!value) {
    return undefined;
  }

  return {
    channel: value.channel ? resolveTemplate(value.channel, variables) : undefined,
    target: value.target ? resolveTemplate(value.target, variables) : undefined,
    accountId: value.accountId
      ? resolveTemplate(value.accountId, variables)
      : undefined,
    replyTo: value.replyTo ? resolveTemplate(value.replyTo, variables) : undefined,
    threadId: value.threadId ? resolveTemplate(value.threadId, variables) : undefined,
    sessionKey: value.sessionKey
      ? resolveTemplate(value.sessionKey, variables)
      : undefined,
  };
}

function resolveTemplate(
  value: string,
  variables: Record<string, string | undefined>,
): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    return variables[name] ?? "";
  });
}
