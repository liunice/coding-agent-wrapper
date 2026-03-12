/**
 * Parses Claude stream-json output into final results and recent activity.
 * Important note: the parser tracks only lightweight state and never changes Codex behavior.
 */

import path from "node:path";

/** Stores one active Claude content block while stream-json events arrive. */
interface ClaudeContentBlockState {
  type: "text" | "tool_use" | "unknown";
  toolName: string | null;
  text: string;
  partialInputJson: string;
}

/** Stores incremental parsing state for one Claude process. */
export interface ClaudeStreamState {
  pendingLine: string;
  blocks: Map<number, ClaudeContentBlockState>;
  sessionId: string | null;
  finalResultText: string | null;
  latestActivityAt: string | null;
  latestActivitySummary: string | null;
}

/** Describes the latest changes observed while consuming one stdout chunk. */
export interface ClaudeStreamChunkResult {
  sawActivity: boolean;
  sessionIdChanged: boolean;
  finalResultChanged: boolean;
}

/** Creates an empty Claude stream parser state. */
export function createClaudeStreamState(): ClaudeStreamState {
  return {
    pendingLine: "",
    blocks: new Map<number, ClaudeContentBlockState>(),
    sessionId: null,
    finalResultText: null,
    latestActivityAt: null,
    latestActivitySummary: null,
  };
}

/** Consumes one stdout chunk from Claude stream-json mode. */
export function consumeClaudeStreamChunk(
  state: ClaudeStreamState,
  chunk: string,
  cwd: string,
): ClaudeStreamChunkResult {
  if (!chunk) {
    return {
      sawActivity: false,
      sessionIdChanged: false,
      finalResultChanged: false,
    };
  }

  const lines = `${state.pendingLine}${chunk}`.split(/\r?\n/);
  state.pendingLine = lines.pop() ?? "";

  let sawActivity = false;
  let sessionIdChanged = false;
  let finalResultChanged = false;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const parsed = parseJsonLine(line);
    if (!parsed) {
      continue;
    }

    if (
      typeof parsed.session_id === "string" &&
      parsed.session_id &&
      parsed.session_id !== state.sessionId
    ) {
      state.sessionId = parsed.session_id;
      sessionIdChanged = true;
    }

    const activitySummary = extractActivitySummary(parsed, state, cwd);
    if (typeof activitySummary === "string" && activitySummary.trim()) {
      recordActivity(state, activitySummary);
      sawActivity = true;
    }

    if (
      parsed.type === "result" &&
      typeof parsed.result === "string" &&
      parsed.result.trim() &&
      parsed.result !== state.finalResultText
    ) {
      state.finalResultText = parsed.result;
      finalResultChanged = true;
    }
  }

  return {
    sawActivity,
    sessionIdChanged,
    finalResultChanged,
  };
}

function parseJsonLine(line: string): ClaudeStreamJsonLine | null {
  try {
    return JSON.parse(line) as ClaudeStreamJsonLine;
  } catch {
    return null;
  }
}

/** Updates the latest activity timestamp and summary from one parsed event. */
function recordActivity(
  state: ClaudeStreamState,
  summary: string | null,
): void {
  state.latestActivityAt = new Date().toISOString();
  if (summary) {
    state.latestActivitySummary = summary;
  }
}

/** Converts one Claude event into a concise activity summary when possible. */
function extractActivitySummary(
  line: ClaudeStreamJsonLine,
  state: ClaudeStreamState,
  cwd: string,
): string | null | undefined {
  if (line.type === "stream_event") {
    return extractStreamEventActivity(line.event, state, cwd);
  }

  if (line.type === "assistant") {
    return extractAssistantActivity(line.message?.content, cwd);
  }

  if (line.type === "user") {
    return extractToolResultActivity(line.message?.content, cwd);
  }

  return undefined;
}

function extractStreamEventActivity(
  event: ClaudeStreamEvent | undefined,
  state: ClaudeStreamState,
  cwd: string,
): string | null | undefined {
  if (!event) {
    return undefined;
  }

  if (event.type === "content_block_start") {
    const block = createContentBlockState(event.content_block);
    state.blocks.set(event.index, block);

    if (block.type === "tool_use") {
      return describeToolUse(
        block.toolName,
        parseJsonObject(block.partialInputJson),
        cwd,
      );
    }

    if (block.type === "text") {
      return null;
    }
  }

  if (event.type === "content_block_delta") {
    const block = state.blocks.get(event.index);
    if (!block) {
      return undefined;
    }

    if (block.type === "text" && event.delta?.type === "text_delta") {
      block.text += event.delta.text ?? "";
      return block.text.trim()
        ? `Drafting response: ${truncate(block.text.trim(), 160)}`
        : null;
    }

    if (block.type === "tool_use" && event.delta?.type === "input_json_delta") {
      block.partialInputJson += event.delta.partial_json ?? "";
      return describeToolUse(
        block.toolName,
        parseJsonObject(block.partialInputJson),
        cwd,
      );
    }

    return undefined;
  }

  if (event.type === "content_block_stop") {
    state.blocks.delete(event.index);
    return undefined;
  }

  return undefined;
}

function createContentBlockState(
  contentBlock: ClaudeContentBlock | undefined,
): ClaudeContentBlockState {
  if (contentBlock?.type === "text") {
    return {
      type: "text",
      toolName: null,
      text: contentBlock.text ?? "",
      partialInputJson: "",
    };
  }

  if (contentBlock?.type === "tool_use") {
    return {
      type: "tool_use",
      toolName: contentBlock.name ?? null,
      text: "",
      partialInputJson: JSON.stringify(contentBlock.input ?? {}),
    };
  }

  return {
    type: "unknown",
    toolName: null,
    text: "",
    partialInputJson: "",
  };
}

function extractAssistantActivity(
  content: ClaudeMessageContent[] | undefined,
  cwd: string,
): string | null {
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }

  for (const item of content) {
    if (item?.type === "tool_use") {
      return describeToolUse(item.name ?? null, item.input ?? null, cwd);
    }
  }

  const text = content
    .filter((item): item is ClaudeMessageTextContent => item?.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();

  return text ? `Drafting response: ${truncate(text, 160)}` : null;
}

function extractToolResultActivity(
  content: ClaudeMessageContent[] | undefined,
  cwd: string,
): string | null {
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }

  for (const item of content) {
    if (item?.type !== "tool_result") {
      continue;
    }

    const filePath =
      item.tool_use_result?.file?.filePath ??
      extractFilePathFromUnknown(item.tool_use_result?.content ?? item.content);
    if (filePath) {
      return `Received tool result from ${formatPathForDisplay(filePath, cwd)}`;
    }

    const text = stringifyUnknown(item.content).trim();
    return text
      ? `Received tool result: ${truncate(text, 160)}`
      : "Received tool result";
  }

  return null;
}

/** Builds a compact description for one Claude tool invocation. */
function describeToolUse(
  toolName: string | null,
  input: Record<string, unknown> | null,
  cwd: string,
): string | null {
  if (!toolName) {
    return null;
  }

  const target =
    readDisplayTarget(input, cwd) ??
    readCommandTarget(input) ??
    readSearchTarget(input) ??
    readUrlTarget(input);

  return target ? `Using ${toolName}: ${target}` : `Using ${toolName}`;
}

function readDisplayTarget(
  input: Record<string, unknown> | null,
  cwd: string,
): string | null {
  const raw =
    readStringProperty(input, "file_path") ??
    readStringProperty(input, "path") ??
    readStringProperty(input, "target_file");
  return raw ? formatPathForDisplay(raw, cwd) : null;
}

function readCommandTarget(
  input: Record<string, unknown> | null,
): string | null {
  const command =
    readStringProperty(input, "command") ?? readStringProperty(input, "cmd");
  return command ? truncate(command, 160) : null;
}

function readSearchTarget(
  input: Record<string, unknown> | null,
): string | null {
  const search =
    readStringProperty(input, "query") ??
    readStringProperty(input, "pattern") ??
    readStringProperty(input, "q");
  return search ? truncate(search, 160) : null;
}

function readUrlTarget(input: Record<string, unknown> | null): string | null {
  const url = readStringProperty(input, "url");
  return url ? truncate(url, 160) : null;
}

function readStringProperty(
  input: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = input?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  if (!value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractFilePathFromUnknown(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = extractFilePathFromUnknown(item);
      if (candidate) {
        return candidate;
      }
    }
    return null;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const direct = readStringProperty(record, "filePath");
    if (direct) {
      return direct;
    }

    for (const nested of Object.values(record)) {
      const candidate = extractFilePathFromUnknown(nested);
      if (candidate) {
        return candidate;
      }
    }
  }

  return null;
}

function formatPathForDisplay(filePath: string, cwd: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedCwd = cwd.replace(/\\/g, "/");

  if (normalizedPath === normalizedCwd) {
    return ".";
  }

  if (normalizedPath.startsWith(`${normalizedCwd}/`)) {
    return normalizedPath.slice(normalizedCwd.length + 1);
  }

  return path.basename(normalizedPath) || normalizedPath;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars - 3)}...`;
}

type ClaudeStreamJsonLine = {
  type?: string;
  result?: unknown;
  session_id?: unknown;
  event?: ClaudeStreamEvent;
  message?: {
    content?: ClaudeMessageContent[];
  };
};

type ClaudeStreamEvent = {
  type?: string;
  index: number;
  content_block?: ClaudeContentBlock;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
  };
};

type ClaudeContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
};

type ClaudeMessageContent =
  | ClaudeMessageTextContent
  | ClaudeMessageToolUseContent
  | ClaudeMessageToolResultContent;

type ClaudeMessageTextContent = {
  type?: "text";
  text?: string;
};

type ClaudeMessageToolUseContent = {
  type?: "tool_use";
  name?: string;
  input?: Record<string, unknown>;
};

type ClaudeMessageToolResultContent = {
  type?: "tool_result";
  content?: unknown;
  tool_use_result?: {
    file?: {
      filePath?: string;
    };
    content?: unknown;
  };
};
