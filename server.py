#!/usr/bin/env python3
"""机甲对战 local server (launched by start.command).

1. Serves the game with Cache-Control: no-store, so a refresh never mixes old and new JS modules.
2. Mech folders: every mech lives in its own folder next to the game, as <name>/<name>.json
   (e.g. 极点/极点.json). GET /api/mechs lists them; POST /api/mechs saves one from the hangar.

Security: listens on 127.0.0.1 only. POST needs the custom header X-Mech: 1 (browsers preflight that for
cross-site requests and this server never answers the preflight, so other websites can't write here).
The folder name comes from a strict whitelist (letters, digits, CJK, - and _), never a path; reserved
folders (js, test, ...) are refused; 512 KB limit; written to a temp file then atomically replaced.

3. /room/create, /room/join, /room/send, /room/recv: an in-memory copy of the signaling mailbox that online
   play uses (the real one is Skybreak's Cloudflare Worker). Only for testing on this machine: open the game
   with ?signal=local and two tabs can connect to each other without the internet.
"""
import http.server
import json
import os
import random
import secrets
import threading
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_BYTES = 512 * 1024
NAME_RE = re.compile(r'^[0-9A-Za-z_\-㐀-鿿豈-﫿]{1,24}$')
RESERVED = {'js', 'test', 'node_modules', 'icons', 'assets'}


def mech_dirs():
    out = []
    for d in sorted(os.listdir(HERE)):
        f = os.path.join(HERE, d, d + '.json')
        if d not in RESERVED and NAME_RE.match(d) and os.path.isfile(f):
            out.append({'name': d, 'path': d + '/' + d + '.json'})
    return out


ROOMS = {}                       # code -> {'peers': {peer: key}, 'box': {peer: [msg]}}
ROOM_LOCK = threading.Lock()


def room_call(path, body):
    """Same requests and answers as the Worker's /room/* (see js/net.js)."""
    with ROOM_LOCK:
        if path == '/room/create':
            code = ''.join(random.choice('ABCDEFGHJKMNPQRSTUVWXYZ') for _ in range(5))
            key = secrets.token_hex(8)
            ROOMS[code] = {'peers': {'h': key}, 'box': {'h': []}}
            return 200, {'code': code, 'peer': 'h', 'key': key}
        if path == '/room/join':
            room = ROOMS.get(str(body.get('code', '')).upper())
            if not room:
                return 404, {'error': 'no such room'}
            if len(room['peers']) >= 4:
                return 409, {'error': 'room is full'}
            peer = 'g%d' % len(room['peers'])
            key = secrets.token_hex(8)
            room['peers'][peer] = key
            room['box'][peer] = []
            return 200, {'code': str(body['code']).upper(), 'peer': peer, 'key': key}
        room = ROOMS.get(str(body.get('code', '')).upper())
        if not room or room['peers'].get(body.get('peer')) != body.get('key'):
            return 401, {'error': 'not in this room'}
        if path == '/room/send':
            if body.get('to') not in room['box']:
                return 404, {'error': 'no such peer'}
            room['box'][body['to']].append({'from': body['peer'], 'data': body.get('data', '')})
            return 200, {'ok': True}
        if path == '/room/recv':
            msgs, room['box'][body['peer']] = room['box'][body['peer']], []
            return 200, {'messages': msgs}
    return 404, {'error': 'unknown'}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        super().end_headers()

    def do_GET(self):
        if self.path.split('?')[0] == '/api/mechs':
            body = json.dumps(mech_dirs(), ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split('?')[0]
        if path.startswith('/room/'):
            try:
                n = int(self.headers.get('Content-Length', '0'))
                body = json.loads(self.rfile.read(n).decode('utf-8')) if 0 < n <= 65536 else {}
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                body = {}
            status, out = room_call(path, body if isinstance(body, dict) else {})
            data = json.dumps(out).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path != '/api/mechs':
            self.send_error(404)
            return
        if self.headers.get('X-Mech') != '1':
            self.send_error(403, 'missing X-Mech header')
            return
        try:
            n = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            n = -1
        if n <= 0 or n > MAX_BYTES:
            self.send_error(413, 'bad size')
            return
        try:
            data = json.loads(self.rfile.read(n).decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_error(400, 'not JSON')
            return
        name = data.get('name') if isinstance(data, dict) else None
        if not isinstance(name, str) or not NAME_RE.match(name) or name in RESERVED:
            self.send_error(400, 'bad mech name (letters, digits, Chinese, - and _ only)')
            return
        folder = os.path.join(HERE, name)
        os.makedirs(folder, exist_ok=True)
        target = os.path.join(folder, name + '.json')
        tmp = target + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, target)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


Handler.extensions_map.update({'.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json'})

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
