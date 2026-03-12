/**
 * Runs a lightweight end-to-end probe for Claude stream-json parsing.
 * Important note: it uses a temporary fake Claude binary and does not call external services.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** A stable fake Claude session id emitted by the probe binary. */
const PROBE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** A stable final result string emitted in the probe result event. */
const PROBE_RESULT = "Mock Claude stream result";

/** Creates the temporary fake Claude executable used by the probe. */
async function createMockClaudeBinary(filePath: string): Promise<void> {
  const source = `#!/usr/bin/env node
const lines = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "${PROBE_SESSION_ID}",
  }),
  JSON.stringify({
    type: "stream_event",
    session_id: "${PROBE_SESSION_ID}",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        name: "Read",
        input: {},
      },
    },
  }),
  JSON.stringify({
    type: "stream_event",
    session_id: "${PROBE_SESSION_ID}",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ file_path: process.cwd() + "/package.json" }),
      },
    },
  }),
  JSON.stringify({
    type: "user",
    session_id: "${PROBE_SESSION_ID}",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_result: {
            file: {
              filePath: process.cwd() + "/package.json",
            },
          },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    session_id: "${PROBE_SESSION_ID}",
    message: {
      content: [
        {
          type: "text",
          text: "Draft answer from mock Claude",
        },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "${PROBE_SESSION_ID}",
    result: "${PROBE_RESULT}",
  }),
];

for (const line of lines) {
  process.stdout.write(line + "\\n");
}
`;

  await writeFile(filePath, source, { encoding: "utf8", mode: 0o755 });
}

/** Runs the wrapper against the fake Claude binary and verifies stream parsing. */
async function main(): Promise<void> {
  const workspace = path.resolve(
    __dirname,
    "..",
    `.probe-workspace-${process.pid}-${Date.now()}`,
  );
  const fakeRepo = path.join(workspace, "repo");
  const outputRoot = path.join(workspace, "runs");
  const mockClaudePath = path.join(workspace, "mock-claude.js");
  const cliPath = path.resolve(__dirname, "cli.js");
  const runId = "probe-claude-stream-json";

  try {
    await mkdir(fakeRepo, { recursive: true });
    await writeFile(path.join(fakeRepo, "package.json"), "{}\n", "utf8");
    await createMockClaudeBinary(mockClaudePath);

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "run",
        "--agent",
        "claude",
        "--cwd",
        fakeRepo,
        "--task",
        "Probe Claude stream-json parsing.",
        "--output-root",
        outputRoot,
        "--run-id",
        runId,
        "--started-at",
        new Date().toISOString(),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODING_AGENT_WRAPPER_CLAUDE_BIN: mockClaudePath,
        },
      },
    );

    assert.equal(
      result.status,
      0,
      result.stderr || result.stdout || "probe run failed",
    );

    const runDir = path.join(outputRoot, runId);
    const resultPayload = JSON.parse(
      await readFile(path.join(runDir, "result.json"), "utf8"),
    ) as {
      sessionId?: string | null;
      summary?: string | null;
    };
    const activityPayload = JSON.parse(
      await readFile(path.join(runDir, "agent-activity.json"), "utf8"),
    ) as {
      summary?: string | null;
    };

    assert.equal(
      resultPayload.sessionId,
      PROBE_SESSION_ID,
      "result.json should keep the Claude session id",
    );
    assert.equal(
      resultPayload.summary,
      PROBE_RESULT,
      "result.json summary should come from the final result event",
    );
    assert.match(
      activityPayload.summary ?? "",
      /Drafting response|Received tool result|Using Read/,
      "agent activity sidecar should contain Claude-originated activity",
    );

    process.stdout.write(
      `${[
        `probe run: ${runId}`,
        `session id captured: ${resultPayload.sessionId}`,
        `summary captured: ${resultPayload.summary}`,
        `latest activity: ${activityPayload.summary ?? "(none)"}`,
        "claude stream-json parsing: PASS",
      ].join("\n")}\n`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
