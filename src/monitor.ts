import { open } from "node:fs/promises";

import { sendProgressNotification } from "./reporter";
import { patchRunStatus, readRunStatus } from "./status";
import type { RunCliOptions, RunContext, RunStatusSnapshot } from "./types";

interface MonitorController {
  stop(): void;
}

export function startProgressMonitor(
  options: RunCliOptions,
  context: RunContext,
  log: (line: string) => void,
): MonitorController {
  const everySeconds = options.progressEverySeconds;
  if (!everySeconds || everySeconds <= 0) {
    return { stop() {} };
  }

  const progressStartAfterSeconds =
    options.progressStartAfterSeconds ?? everySeconds;
  const startedAtMs = Date.parse(context.startedAt);
  const firstReportAtMs = startedAtMs + progressStartAfterSeconds * 1000;

  let stopped = false;
  let sending = false;
  let timeoutHandle: NodeJS.Timeout | null = null;

  const scheduleNext = (nowMs: number): void => {
    if (stopped) {
      return;
    }

    const targetMs = getNextScheduledReportAtMs(
      nowMs,
      startedAtMs,
      firstReportAtMs,
      everySeconds,
    );
    const delayMs = Math.max(1000, targetMs - nowMs);

    timeoutHandle = setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped || sending) {
      return;
    }

    const nowMs = Date.now();
    const status = await readRunStatus(context.statusPath);
    if (!status || status.resultState !== "pending") {
      scheduleNext(nowMs);
      return;
    }

    const elapsedSeconds = Math.max(
      0,
      Math.floor((nowMs - Date.parse(status.startedAt)) / 1000),
    );

    const shouldReport = shouldSendProgressReport(
      status,
      nowMs,
      startedAtMs,
      firstReportAtMs,
      everySeconds,
    );

    if (!shouldReport) {
      scheduleNext(nowMs);
      return;
    }

    sending = true;
    try {
      const recentActivity = await readRecentMeaningfulActivity(
        context.logPath,
      );
      const text = buildProgressText(
        options,
        context,
        status,
        elapsedSeconds,
        recentActivity,
      );
      const delivered = await sendProgressNotification(options, text, log);
      if (delivered) {
        await patchRunStatus(options, context, {
          reporting: {
            lastReportAt: new Date(nowMs).toISOString(),
            lastReportedPhase: status.phase,
            reportCountIncrement: 1,
          },
        });
      }
    } finally {
      sending = false;
      scheduleNext(Date.now());
    }
  };

  scheduleNext(Date.now());

  return {
    stop() {
      stopped = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    },
  };
}

function shouldSendProgressReport(
  status: RunStatusSnapshot,
  nowMs: number,
  startedAtMs: number,
  firstReportAtMs: number,
  everySeconds: number,
): boolean {
  if (Number.isNaN(startedAtMs) || nowMs < firstReportAtMs) {
    return false;
  }

  const slotIndex = Math.floor(
    (nowMs - firstReportAtMs) / (everySeconds * 1000),
  );
  const expectedReportCount = slotIndex + 1;
  if (status.reporting.reportCount >= expectedReportCount) {
    return false;
  }

  return true;
}

function getNextScheduledReportAtMs(
  nowMs: number,
  startedAtMs: number,
  firstReportAtMs: number,
  everySeconds: number,
): number {
  if (Number.isNaN(startedAtMs) || nowMs <= firstReportAtMs) {
    return firstReportAtMs;
  }

  const everyMs = everySeconds * 1000;
  const slotIndex = Math.floor((nowMs - firstReportAtMs) / everyMs) + 1;
  return firstReportAtMs + slotIndex * everyMs;
}

function buildProgressText(
  options: RunCliOptions,
  context: RunContext,
  status: RunStatusSnapshot,
  elapsedSeconds: number,
  recentActivity: string | null,
): string {
  const elapsedMinutes = (elapsedSeconds / 60).toFixed(1);
  const name = options.label ?? context.runId;
  const progressSummary = recentActivity ?? status.summary;

  return [
    `后台任务进行中：${name}`,
    "",
    "**【当前状态】**",
    `• Agent: ${options.agent}`,
    `• Phase: ${status.phase}`,
    `• Run ID: ${context.runId}`,
    `• 已运行(分钟): ${elapsedMinutes}`,
    `• 最近更新: ${formatDisplayTime(status.updatedAt)}`,
    "",
    "**【任务目标】**",
    `• ${context.taskSummary}`,
    "",
    "**【进度摘要】**",
    `• ${progressSummary}`,
    "",
    "**【会话】**",
    `• Session ID: ${status.sessionId ?? "unknown"}`,
    `• Resume 来源: ${status.resumedFromSessionId ?? "(new session)"}`,
    "",
    "**【产物】**",
    `• 状态文件: ${formatRunArtifactPath(context.runId, context.statusPath)}`,
    `• 日志文件: ${formatRunArtifactPath(context.runId, context.logPath)}`,
  ].join("\n");
}

async function readRecentMeaningfulActivity(
  logPath: string,
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(logPath, "r");
    const stats = await handle.stat();
    const readBytes = Math.min(stats.size, 32 * 1024);
    const buffer = Buffer.alloc(readBytes);
    await handle.read(
      buffer,
      0,
      readBytes,
      Math.max(0, stats.size - readBytes),
    );
    const content = buffer.toString("utf8");
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const recentActivities: string[] = [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const activity = normalizeMeaningfulLogLine(lines[index]);
      if (!activity) {
        continue;
      }
      if (recentActivities[0] === activity || recentActivities.includes(activity)) {
        continue;
      }
      recentActivities.unshift(activity);
      if (recentActivities.length >= 3) {
        break;
      }
    }

    if (recentActivities.length === 0) {
      return null;
    }

    return truncateForDisplay(recentActivities.join(" | "), 240);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function normalizeMeaningfulLogLine(line: string): string | null {
  if (!line) {
    return null;
  }

  const ignoredPrefixes = [
    "[wrapper]",
    "OpenAI Codex",
    "workdir:",
    "model:",
    "provider:",
    "approval:",
    "sandbox:",
    "reasoning effort:",
    "reasoning summaries:",
    "session id:",
    "--------",
    "tokens used",
    "mcp:",
    "mcp startup:",
    "user",
  ];
  if (ignoredPrefixes.some((prefix) => line.startsWith(prefix))) {
    return null;
  }

  if (line === "codex" || line === "thinking" || line === "exec") {
    return null;
  }

  if (/^[{}\[\](),:;]+$/.test(line)) {
    return null;
  }

  if (/^\d+$/.test(line)) {
    return null;
  }

  if (/^succeeded in /i.test(line) || /^failed in /i.test(line)) {
    return `最近命令结果：${line}`;
  }

  if (line.startsWith("/bin/sh -lc ")) {
    return `最近执行：${truncateForDisplay(line, 160)}`;
  }

  if (line.startsWith("**") || line.startsWith("- ")) {
    return truncateForDisplay(line, 160);
  }

  return truncateForDisplay(line, 160);
}

function truncateForDisplay(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars - 3)}...`;
}

function formatDisplayTime(value: string | null): string {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatRunArtifactPath(runId: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const marker = `/runs/${runId}/`;
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) {
    return `runs/${runId}/${normalized.slice(markerIndex + marker.length)}`;
  }
  return normalized;
}
