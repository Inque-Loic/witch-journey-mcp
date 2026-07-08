import { spawn } from "node:child_process";
import { once } from "node:events";

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL(".", import.meta.url),
  stdio: ["pipe", "pipe", "inherit"]
});

const lines = [];
let output = Buffer.alloc(0);
child.stdout.setEncoding("binary");
child.stdout.on("data", data => {
  output = Buffer.concat([output, Buffer.from(data, "binary")]);
  while (true) {
    const headerEnd = output.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = output.subarray(0, headerEnd).toString("ascii");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) throw new Error(`bad header: ${header}`);
    const length = Number(match[1]);
    if (output.subarray(headerEnd + 4).length < length) return;
    const bodyStart = headerEnd + 4;
    const body = output.subarray(bodyStart, bodyStart + length).toString("utf8");
    output = output.subarray(bodyStart + length);
    lines.push(JSON.parse(body));
  }
});

function send(id, method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

send(1, "initialize", {});
send(2, "tools/list", {});

await new Promise(resolve => setTimeout(resolve, 300));
child.kill();
await once(child, "exit");

const init = lines.find(x => x.id === 1);
const list = lines.find(x => x.id === 2);
if (!init?.result?.serverInfo || !Array.isArray(list?.result?.tools)) {
  console.error(JSON.stringify(lines, null, 2));
  process.exit(1);
}

console.log(`ok: ${list.result.tools.length} tools`);
