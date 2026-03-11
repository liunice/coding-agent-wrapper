/**
 * Verifies notify routing order and non-short-circuit delivery behavior.
 * Important note: it uses a temporary mock OpenClaw binary so no real message
 * channel or session backend is contacted during the probe.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { sendCompletionNotification } from "./reporter";
import type { RunCliOptions } from "./types";

/** Creates the fake OpenClaw executable that records every notify invocation. */
async function createMockOpenClawBinary(
  filePath: string,
  callsPath: string,
): Promise<void> {
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");
process.exit(0);
`;

  await writeFile(filePath, source, { encoding: "utf8", mode: 0o755 });
}

/** Runs the notify-order probe and prints a short PASS message. */
async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..");
  await cleanupProbeWorkspaces(repoRoot);

  const workspace = path.resolve(
    repoRoot,
    `.probe-workspace-${process.pid}-${Date.now()}`,
  );
  const callsPath = path.join(workspace, "notify-calls.log");
  const openclawPath = path.join(workspace, "mock-openclaw.js");
  const previousOpenClawBin = process.env.OPENCLAW_BIN;

  try {
    await mkdir(workspace, { recursive: true });
    await createMockOpenClawBinary(openclawPath, callsPath);
    process.env.OPENCLAW_BIN = openclawPath;

    const logLines: string[] = [];
    const options: RunCliOptions = {
      command: "run",
      agent: "codex",
      cwd: repoRoot,
      task: "notify routing probe",
      detach: false,
      outputRoot: path.join(workspace, "runs"),
      internalRun: false,
      resumeMode: "never",
      notifySessionKey: "session-probe",
      notifyChannel: "telegram",
      notifyTarget: "123456",
      notifyAccount: "default",
      passthroughArgs: [],
    };

    const delivered = await sendCompletionNotification(
      options,
      "probe completion message",
      (line) => {
        logLines.push(line);
      },
    );

    assert.equal(
      delivered,
      true,
      "at least one notification route should succeed",
    );

    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

    assert.equal(calls.length, 2, "both notify routes should be attempted");
    assert.deepEqual(calls[0]?.slice(0, 2), ["message", "send"]);
    assert.deepEqual(calls[1]?.slice(0, 3), ["gateway", "call", "chat.inject"]);

    const messageAttemptIndex = logLines.findIndex((line) =>
      line.includes("attempt=message-send"),
    );
    const sessionAttemptIndex = logLines.findIndex((line) =>
      line.includes("attempt=chat-inject"),
    );

    assert.notEqual(messageAttemptIndex, -1, "message-send log should exist");
    assert.notEqual(sessionAttemptIndex, -1, "chat-inject log should exist");
    assert.ok(
      messageAttemptIndex < sessionAttemptIndex,
      "message-send should be logged before chat-inject",
    );
    assert.ok(
      logLines.some((line) =>
        line.includes("result=message-send exit=0 success=true"),
      ),
      "message-send result should be logged",
    );
    assert.ok(
      logLines.some((line) =>
        line.includes("result=chat-inject exit=0 success=true"),
      ),
      "chat-inject result should be logged",
    );
    assert.ok(
      logLines.some((line) =>
        line.includes("finished success=true attempted=2"),
      ),
      "final notify summary should be logged",
    );

    process.stdout.write("notify routing probe: PASS\n");
  } finally {
    if (previousOpenClawBin === undefined) {
      process.env.OPENCLAW_BIN = undefined;
    } else {
      process.env.OPENCLAW_BIN = previousOpenClawBin;
    }

    await rm(workspace, { recursive: true, force: true });
    await cleanupProbeWorkspaces(repoRoot);
  }
}

/** Removes stale probe workspaces so repository lint does not pick them up later. */
async function cleanupProbeWorkspaces(repoRoot: string): Promise<void> {
  const entries = await readdir(repoRoot, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith(".probe-workspace-"),
      )
      .map((entry) =>
        rm(path.join(repoRoot, entry.name), { recursive: true, force: true }),
      ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
