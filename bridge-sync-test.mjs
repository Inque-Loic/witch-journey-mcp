import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "witch-bridge-sync-test-"));
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: {
    ...process.env,
    WITCH_JOURNEY_GAME_ROOT: tempRoot
  },
  stdio: ["pipe", "pipe", "inherit"]
});

const messages = [];
let output = Buffer.alloc(0);
child.stdout.setEncoding("binary");
child.stdout.on("data", data => {
  output = Buffer.concat([output, Buffer.from(data, "binary")]);
  while (true) {
    const headerEnd = output.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const match = /content-length:\s*(\d+)/i.exec(output.subarray(0, headerEnd).toString("ascii"));
    if (!match) throw new Error("missing content-length");
    const length = Number(match[1]);
    if (output.subarray(headerEnd + 4).length < length) return;
    const bodyStart = headerEnd + 4;
    const body = output.subarray(bodyStart, bodyStart + length).toString("utf8");
    output = output.subarray(bodyStart + length);
    messages.push(JSON.parse(body));
  }
});

function send(id, method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

async function waitForMessage(id, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const message = messages.find(item => item.id === id);
    if (message) return message;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for message ${id}`);
}

send(1, "initialize", {});
await waitForMessage(1);
send(2, "tools/call", {
  name: "witch_sync_bridge_artifacts",
  arguments: {
    dryRun: true,
    includeDiagnostics: false
  }
});
send(3, "tools/call", {
  name: "witch_sync_bridge_artifacts",
  arguments: {
    dryRun: false,
    confirm: "SYNC_BRIDGE_ARTIFACTS",
    includeDiagnostics: false,
    waitForUnlock: true,
    timeoutMs: 1000,
    pollMs: 100
  }
});

await waitForMessage(2);
await waitForMessage(3);
child.kill();
await once(child, "exit");

function textResult(id) {
  const message = messages.find(item => item.id === id);
  if (!message?.result?.content?.[0]?.text) {
    throw new Error(`missing result ${id}: ${JSON.stringify(messages, null, 2)}`);
  }
  return JSON.parse(message.result.content[0].text);
}

const dryRun = textResult(2);
const realSync = textResult(3);
const expectedDestination = path.join(tempRoot, "Witch's Apocalyptic Journey_Data", "Mods", "CodexMcpBridge", "Scripts", "Entry.dll");

try {
  if (!dryRun.ok || dryRun.reason !== "sync_ready" || dryRun.sync?.destination !== expectedDestination || dryRun.attempts?.length !== 1) {
    throw new Error(`bad dry-run sync ${JSON.stringify(dryRun, null, 2)}`);
  }
  if (!realSync.ok || realSync.reason !== "synced" || realSync.sync?.destination !== expectedDestination || realSync.waitForUnlock !== true || realSync.attempts?.length !== 1) {
    throw new Error(`bad real sync ${JSON.stringify(realSync, null, 2)}`);
  }
  const copied = await fs.readFile(expectedDestination);
  if (!bufferIncludesString(copied, "battle.snapshot") || !bufferIncludesString(copied, "runtime.inspect")) {
    throw new Error("copied bridge DLL is missing expected command markers");
  }
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function bufferIncludesString(buffer, value) {
  return buffer.includes(Buffer.from(value, "utf8")) || buffer.includes(Buffer.from(value, "utf16le"));
}

console.log("ok: bridge artifact sync");
