#!/usr/bin/env python3
"""Serve a folder of MP3 files. Python 3.8+, no dependencies."""
import argparse
import hashlib
import json
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
from urllib.parse import quote, unquote, urlsplit


class PlayerHandler(BaseHTTPRequestHandler):
    def __init__(self, *args, music_dir, lyrics_dir=None, **kwargs):
        self.music_dir = music_dir
        self.lyrics_dir = (lyrics_dir or music_dir / 'Lyrics').resolve()
        self.library_id = hashlib.sha256(str(music_dir).encode('utf-8')).hexdigest()[:20]
        super().__init__(*args, **kwargs)

    def do_HEAD(self):
        self.serve(head=True)

    def do_GET(self):
        self.serve(head=False)

    def reply(self, data, content_type, head):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Library-Id', self.library_id)
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def is_track(self, path):
        # Only immediate files inside the selected folder; reject escaping symlinks.
        return (path.suffix.lower() == '.mp3' and path.is_file()
                and path.resolve().parent == self.music_dir)

    def find_lyrics(self, track):
        if not self.lyrics_dir.is_dir():
            return None
        files = [p for p in self.lyrics_dir.iterdir()
                 if p.suffix.lower() == '.lrc' and p.is_file()
                 and p.resolve().parent == self.lyrics_dir]
        stems = [track.stem]
        while stems[-1].casefold().endswith('.mp3'):
            stems.append(stems[-1][:-4])
        for stem in stems:
            literal = [p for p in files if p.name == stem + '.lrc']
            if literal:
                return literal[0]
            exact = [p for p in files if p.stem.casefold() == stem.casefold()]
            if len(exact) == 1:
                return exact[0]
        # Prefer exact names; accept an unambiguous suffixed lyric filename.
        for stem in stems:
            matches = [p for p in files if p.stem.casefold().startswith(stem.casefold())]
            if len(matches) == 1:
                return matches[0]
        return None

    def serve(self, head):
        try:
            route = urlsplit(self.path).path
            if route == '/':
                self.reply(Path(__file__).with_name('index.html').read_bytes(),
                           'text/html; charset=utf-8', head)
            elif route == '/api/tracks':
                tracks = [{'name': p.name, 'url': '/media/' + quote(p.name, safe='')}
                          for p in sorted(self.music_dir.iterdir(), key=lambda p: p.name.casefold())
                          if self.is_track(p)]
                self.reply(json.dumps(tracks, ensure_ascii=False).encode('utf-8'),
                           'application/json; charset=utf-8', head)
            elif route.startswith(('/media/', '/lyrics/')):
                name = unquote(route.split('/', 2)[2])
                if '/' in name or '\\' in name or not name:
                    self.send_error(404)
                    return
                path = self.music_dir / name
                if not self.is_track(path):
                    self.send_error(404)
                    return
                if route.startswith('/media/'):
                    self.stream(path, head)
                else:
                    lyric = self.find_lyrics(path)
                    if lyric is None:
                        self.send_error(404)
                        return
                    raw = lyric.read_bytes()
                    try:
                        text = raw.decode('utf-8-sig')
                    except UnicodeDecodeError:
                        text = raw.decode('gb18030', errors='replace')
                    self.reply(text.encode('utf-8'), 'text/plain; charset=utf-8', head)
            else:
                self.send_error(404)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Normal when seeking or switching tracks.
        except (FileNotFoundError, PermissionError):
            self.send_error(404)

    def stream(self, path, head):
        with path.open('rb') as audio:
            size = audio.seek(0, 2)
            start, end, status = 0, size - 1, 200
            value = self.headers.get('Range', '') if not head else ''
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', value)
            # Ignore unsupported/multiple ranges and send a complete 200 response.
            if match and any(match.groups()):
                first, last = match.groups()
                if first:
                    start = int(first)
                    end = min(int(last), size - 1) if last else size - 1
                else:
                    start = max(0, size - int(last))
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                status = 206
            length = max(0, end - start + 1)
            self.send_response(status)
            self.send_header('Content-Type', 'audio/mpeg')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(length))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            if head:
                return
            audio.seek(start)
            while length:
                chunk = audio.read(min(length, 64 * 1024))
                if not chunk:
                    break
                self.wfile.write(chunk)
                length -= len(chunk)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path, help='MP3 folder (not recursive)')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--bind', default='0.0.0.0')
    parser.add_argument('--lyrics-dir', type=Path, help='LRC folder; default: <music folder>/Lyrics')
    args = parser.parse_args()
    folder = args.folder.expanduser().resolve()
    if not folder.is_dir():
        parser.error('Folder does not exist: ' + str(folder))
    lyrics_dir = args.lyrics_dir.expanduser().resolve() if args.lyrics_dir else folder / 'Lyrics'
    handler = partial(PlayerHandler, music_dir=folder, lyrics_dir=lyrics_dir)
    with ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f'MP3 folder: {folder}', flush=True)
        print(f'Listening on http://{args.bind}:{server.server_port}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
