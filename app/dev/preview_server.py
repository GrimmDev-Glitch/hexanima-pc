"""Vista previa de la interfaz en un navegador (solo desarrollo).

Sirve app/ui tal cual e inyecta dev/tauri_stub.js antes de app.js, para revisar el
diseño sin compilar Tauri. El motor real se arranca aparte en SD_PORT (por defecto 18780):
  engine/vulkan/sd-server.exe --listen-port 18780 --model-dir models --lora-model-dir loras ...
Uso: python app/dev/preview_server.py [puerto_http]
"""
import http.server
import socketserver
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
UI = HERE.parent / "ui"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5173


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(UI), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/__stub.js":
            return self._send((HERE / "tauri_stub.js").read_bytes(), "text/javascript")
        if path in ("/", "/index.html"):
            html = (UI / "index.html").read_text(encoding="utf-8")
            html = html.replace('<script src="app.js"></script>',
                                '<script src="/__stub.js"></script>\n<script src="app.js"></script>')
            return self._send(html.encode("utf-8"), "text/html; charset=utf-8")
        return super().do_GET()

    def _send(self, data, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"Vista previa en http://127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()
