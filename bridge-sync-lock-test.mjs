import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

if (process.platform !== "win32") {
  console.log("ok: bridge sync lock classification skipped on non-Windows");
  process.exit(0);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "witch-bridge-sync-lock-test-"));
const expectedDestination = path.join(tempRoot, "Witch's Apocalyptic Journey_Data", "Mods", "CodexMcpBridge", "Scripts", "Entry.dll");
const lockReadyPath = path.join(tempRoot, "lock-ready.txt");
let lockProcess = null;
let child = null;

try {
  await fs.mkdir(path.dirname(expectedDestination), { recursive: true });
  await fs.writeFile(expectedDestination, "locked placeholder");
  lockProcess = spawn("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "$path=$env:WITCH_LOCK_PATH",
      "$ready=$env:WITCH_LOCK_READY",
      "$fs=[System.IO.File]::Open($path,[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)",
      "Set-Content -LiteralPath $ready -Value ready -Encoding UTF8",
      "Start-Sleep -Seconds 15",
      "$fs.Dispose()"
    ].join("; ")
  ], {
    env: {
      ...process.env,
      WITCH_LOCK_PATH: expectedDestination,
      WITCH_LOCK_READY: lockReadyPath
    },
    stdio: ["ignore", "ignore", "inherit"]
  });

  await waitForFile(lockReadyPath, 5000);

  child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      WITCH_JOURNEY_GAME_ROOT: tempRoot
    },
    stdio: ["pipe", "pipe", "inherit"]
  });

  const messages = collectMcpMessages(child);
  send(child, 1, "initialize", {});
  await waitForMessage(messages, 1);
  send(child, 2, "tools/call", {
    name: "witch_sync_bridge_artifacts",
    arguments: {
      dryRun: false,
      confirm: "SYNC_BRIDGE_ARTIFACTS",
      includeDiagnostics: false,
      waitForUnlock: false
    }
  });
  await waitForMessage(messages, 2);

  const sync = textResult(messages, 2);
  if (sync.ok !== false || sync.reason !== "copy_target_locked_or_unavailable" || sync.sync?.errorCategory !== "target_locked_or_unavailable") {
    throw new Error(`bad locked sync classification ${JSON.stringify(sync, null, 2)}`);
  }
  if (!String(sync.sync?.nextAction || "").includes("Close or restart")) {
    throw new Error(`locked sync did not include actionable nextAction ${JSON.stringify(sync.sync, null, 2)}`);
  }
} finally {
  if (child) {
    child.kill();
    await once(child, "exit").catch(() => {});
  }
  if (lockProcess) {
    lockProcess.kill();
    await once(lockProcess, "exit").catch(() => {});
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("ok: bridge sync locked-DLL classification");

function collectMcpMessages(processHandle) {
  const messages = [];
  let output = Buffer.alloc(0);
  processHandle.stdout.setEncoding("binary");
  processHandle.stdout.on("data", data => {
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
  return messages;
}

function send(processHandle, id, method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  processHandle.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

async function waitForMessage(messages, id, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const message = messages.find(item => item.id === id);
    if (message) return message;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for message ${id}`);
}

async function waitForFile(filePath, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fs.stat(filePath);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function textResult(messages, id) {
  const message = messages.find(item => item.id === id);
  if (!message?.result?.content?.[0]?.text) {
    throw new Error(`missing result ${id}: ${JSON.stringify(messages, null, 2)}`);
  }
  return JSON.parse(message.result.content[0].text);
}
