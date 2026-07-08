import argparse
import json
import os
import pathlib
import subprocess
import sys
import tomllib


def frame(payload: dict) -> bytes:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body


def read_frame(stream):
    headers = b""
    while b"\r\n\r\n" not in headers:
        chunk = stream.read(1)
        if not chunk:
            raise RuntimeError("server closed before response headers")
        headers += chunk
    header_blob, rest = headers.split(b"\r\n\r\n", 1)
    length = None
    for line in header_blob.decode("ascii").split("\r\n"):
        if line.lower().startswith("content-length:"):
            length = int(line.split(":", 1)[1].strip())
    if length is None:
        raise RuntimeError(f"missing content-length in {header_blob!r}")
    body = rest + stream.read(length - len(rest))
    return json.loads(body.decode("utf-8"))


def load_server():
    config = pathlib.Path.home() / ".codex" / "config.toml"
    data = tomllib.loads(config.read_text(encoding="utf-8"))
    server = data["mcp_servers"]["witchJourney"]
    env = os.environ.copy()
    for key, value in server.get("env", {}).items():
        if key not in env:
            env[key] = value
    return [server["command"], *server.get("args", [])], env


def read_arguments(args):
    if args.stdin:
        raw = read_stdin_text()
    elif args.json_file:
        raw = pathlib.Path(args.json_file).read_text(encoding="utf-8-sig")
    elif args.arguments == "-":
        raw = read_stdin_text()
    elif args.arguments.startswith("@"):
        raw = pathlib.Path(args.arguments[1:]).read_text(encoding="utf-8-sig")
    else:
        raw = args.arguments
    raw = raw.lstrip("\ufeff")

    try:
        tool_args = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"arguments must be JSON: {exc}")
    if not isinstance(tool_args, dict):
        raise SystemExit("arguments must decode to a JSON object")
    return tool_args


def read_stdin_text():
    data = sys.stdin.buffer.read()
    if data:
        return data.decode("utf-8-sig")
    return sys.stdin.read().lstrip("\ufeff")


def main():
    parser = argparse.ArgumentParser(description="Call one configured witchJourney MCP tool.")
    parser.add_argument("tool", help="Tool name, e.g. witch_status")
    parser.add_argument("arguments", nargs="?", default="{}", help="JSON object tool arguments, @path for a JSON file, or - for stdin")
    parser.add_argument("--json-file", help="Read the JSON object arguments from this file")
    parser.add_argument("--stdin", action="store_true", help="Read the JSON object arguments from stdin")
    args = parser.parse_args()
    tool_args = read_arguments(args)

    command, env = load_server()
    proc = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )

    try:
        proc.stdin.write(frame({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}))
        proc.stdin.write(frame({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": args.tool, "arguments": tool_args}}))
        proc.stdin.flush()
        init = read_frame(proc.stdout)
        result = read_frame(proc.stdout)
    finally:
        proc.kill()

    if "error" in init:
        print(json.dumps(init, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if "error" not in result else 1


if __name__ == "__main__":
    raise SystemExit(main())
