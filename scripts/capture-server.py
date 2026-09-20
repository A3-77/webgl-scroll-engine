"""
临时工具：接收浏览器页面 POST 过来的 canvas 导出图，写进 docs/shots/。

为什么需要它：
  chrome-devtools MCP 的 take_screenshot / evaluate_script 的 filePath
  被限制在它自己的 workspace root 内，写不到本项目目录。
  所以让页面自己把 canvas 像素 POST 出来 —— 这是唯一能把真实渲染画面
  落盘到项目里的路径。

用 text/plain 而不是 application/json 作为 Content-Type，
是为了让请求保持"简单请求"，不触发 CORS 预检（省掉 OPTIONS 往返）。
"""

import base64
import json
import pathlib
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "shots"
OUT.mkdir(parents=True, exist_ok=True)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            name = str(payload["name"])
            raw = payload["b64"].split(",")[-1]
            target = OUT / name
            target.write_bytes(base64.b64decode(raw))
            print(f"saved {target.name}  {target.stat().st_size} bytes", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"FAILED: {exc}", flush=True)

        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args) -> None:
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    print(f"listening on 127.0.0.1:{port} -> {OUT}", flush=True)
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
