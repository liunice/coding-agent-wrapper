/**
 * Provides a wrapper-native tail command for run logs.
 * Important note: follow mode uses Node-based polling instead of shelling out
 * to system tail so behavior stays portable and easier to extend.
 */

import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import path from "node:path";

import type { TailCliOptions } from "./types";

/** Poll interval for follow mode when checking for appended log content. */
const FOLLOW_POLL_INTERVAL_MS = 500;

/** Runs the `tail` subcommand against one wrapper run log. */
export async function tailRunLog(options: TailCliOptions): Promise<number> {
  const logPath = await resolveRunLogPath(options);
  const { fileSize, text } = await readLastLines(logPath, options.lines);
  writeOutput(text);

  if (!options.follow) {
    return 0;
  }

  await followLogFile(logPath, fileSize);
  return 0;
}

/** Resolves the expected run.log path and validates it exists. */
async function resolveRunLogPath(options: TailCliOptions): Promise<string> {
  const runDir = path.resolve(options.outputRoot, options.runId);
  const logPath = path.join(runDir, "run.log");

  try {
    await access(logPath, constants.F_OK | constants.R_OK);
  } catch {
    throw new Error(`Run log not found for runId ${options.runId}: ${logPath}`);
  }

  return logPath;
}

/** Reads the last N lines without depending on the system tail binary. */
async function readLastLines(
  filePath: string,
  lineCount: number,
): Promise<{ fileSize: number; text: string }> {
  const file = await open(filePath, "r");

  try {
    const stats = await file.stat();
    const fileSize = stats.size;

    if (fileSize === 0) {
      return { fileSize, text: "" };
    }

    const chunkSize = 64 * 1024;
    let position = fileSize;
    let bufferedText = "";
    let newlineCount = 0;

    while (position > 0 && newlineCount <= lineCount) {
      const bytesToRead = Math.min(chunkSize, position);
      position -= bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
      const chunk = buffer.subarray(0, bytesRead).toString("utf8");
      bufferedText = `${chunk}${bufferedText}`;
      newlineCount = countNewlines(bufferedText);
    }

    return {
      fileSize,
      text: selectLastLines(bufferedText, lineCount),
    };
  } finally {
    await file.close();
  }
}

/** Follows appended file content until the user interrupts the command. */
async function followLogFile(
  filePath: string,
  initialOffset: number,
): Promise<void> {
  let currentOffset = initialOffset;

  await new Promise<void>((resolve, reject) => {
    let stopped = false;

    const stopFollowing = (): void => {
      if (stopped) {
        return;
      }

      stopped = true;
      clearInterval(timer);
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      resolve();
    };

    const handleSignal = (): void => {
      stopFollowing();
    };

    const timer = setInterval(() => {
      void readAppendedContent(filePath, currentOffset)
        .then(({ nextOffset, text }) => {
          currentOffset = nextOffset;
          writeOutput(text);
        })
        .catch((error: unknown) => {
          clearInterval(timer);
          process.off("SIGINT", handleSignal);
          process.off("SIGTERM", handleSignal);
          reject(error);
        });
    }, FOLLOW_POLL_INTERVAL_MS);

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
  });
}

/** Reads any newly appended bytes since the previous follow offset. */
async function readAppendedContent(
  filePath: string,
  offset: number,
): Promise<{ nextOffset: number; text: string }> {
  const stats = await stat(filePath);
  if (stats.size <= offset) {
    if (stats.size < offset) {
      return await readAppendedRange(filePath, 0, stats.size);
    }

    return { nextOffset: offset, text: "" };
  }

  return await readAppendedRange(filePath, offset, stats.size);
}

/** Reads a byte range from the file and returns the new follow offset. */
async function readAppendedRange(
  filePath: string,
  startOffset: number,
  endOffset: number,
): Promise<{ nextOffset: number; text: string }> {
  const file = await open(filePath, "r");

  try {
    const bytesToRead = Math.max(0, endOffset - startOffset);
    if (bytesToRead === 0) {
      return { nextOffset: endOffset, text: "" };
    }

    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, startOffset);
    return {
      nextOffset: startOffset + bytesRead,
      text: buffer.subarray(0, bytesRead).toString("utf8"),
    };
  } finally {
    await file.close();
  }
}

/** Counts line breaks in a UTF-8 string. */
function countNewlines(value: string): number {
  return (value.match(/\n/g) ?? []).length;
}

/** Selects the last N logical lines while preserving their trailing newline. */
function selectLastLines(value: string, lineCount: number): string {
  const endsWithNewline = value.endsWith("\n");
  const rawLines = value.split(/\r?\n/);
  const lines = endsWithNewline ? rawLines.slice(0, -1) : rawLines;
  const selected = lines.slice(-lineCount).join("\n");

  if (!selected) {
    return "";
  }

  return endsWithNewline ? `${selected}\n` : selected;
}

/** Writes log output chunks without adding extra formatting. */
function writeOutput(text: string): void {
  if (!text) {
    return;
  }

  process.stdout.write(text);
}
