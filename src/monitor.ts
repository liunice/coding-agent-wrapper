import { sendProgressNotification } from "./reporter";
import { patchRunStatus, readRunStatus } from "./status";
import type { CliOptions, RunContext, RunStatusSnapshot } from "./types";

interface MonitorController {
  stop(): void;
}

export function startProgressMonitor(
  options: CliOptions,
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
      const text = buildProgressText(options, context, status, elapsedSeconds);
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
  options: CliOptions,
  context: RunContext,
  status: RunStatusSnapshot,
  elapsedSeconds: number,
): string {
  const elapsedMinutes = (elapsedSeconds / 60).toFixed(1);
  const name = options.label ?? context.runId;

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
    `• ${status.summary}`,
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
