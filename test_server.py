import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class PlayerTest(unittest.TestCase):
    def test_http_playback_contract(self):
        script = Path(__file__).with_name('server.py')
        self.assertTrue(script.is_file(), 'MP3 service has not been implemented')
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / '歌曲 #1.MP3').write_bytes(b'0123456789')
            (root / 'private.txt').write_text('secret')
            lyrics = root / 'Lyrics'
            lyrics.mkdir()
            (lyrics / '歌曲 #1.lrc').write_text('[00:01.000]你好\n[00:02.50]世界', encoding='utf-8-sig')
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            process = subprocess.Popen([sys.executable, str(script), folder,
                                        '--bind', '127.0.0.1', '--port', str(port)],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            base = f'http://127.0.0.1:{port}'
            def get(path, headers=None, method='GET'):
                try:
                    response = urlopen(Request(base + path, headers=headers or {}, method=method), timeout=2)
                except HTTPError as error:
                    response = error
                with response:
                    return response.status, response.headers, response.read()
            try:
                for _ in range(100):
                    try:
                        status, _, _ = get('/')
                        break
                    except URLError:
                        if process.poll() is not None:
                            self.fail('Server exited before accepting requests')
                        time.sleep(0.05)
                else:
                    self.fail('Server did not start')
                self.assertEqual(status, 200)
                status, library_headers, body = get('/api/tracks')
                self.assertEqual(status, 200)
                self.assertTrue(library_headers.get('X-Library-Id'))
                tracks = json.loads(body)
                self.assertEqual([t['name'] for t in tracks], ['歌曲 #1.MP3'])
                url = tracks[0]['url']
                status, headers, body = get(url)
                self.assertEqual((status, body), (200, b'0123456789'))
                self.assertEqual(headers['Content-Type'], 'audio/mpeg')
                for value, expected, content_range in [
                    ('bytes=2-5', b'2345', 'bytes 2-5/10'),
                    ('bytes=7-', b'789', 'bytes 7-9/10'),
                    ('bytes=-3', b'789', 'bytes 7-9/10'),
                    ('bytes=8-100', b'89', 'bytes 8-9/10')]:
                    with self.subTest(range=value):
                        status, headers, body = get(url, {'Range': value})
                        self.assertEqual((status, body), (206, expected))
                        self.assertEqual(headers['Content-Range'], content_range)
                for value in ['bytes=10-', 'bytes=5-2', 'bytes=-0']:
                    self.assertEqual(get(url, {'Range': value})[0], 416)
                status, headers, body = get(url, method='HEAD')
                self.assertEqual((status, headers['Content-Length'], body), (200, '10', b''))
                for path in ['/media/..%2Fsecret.mp3', '/media/private.txt', '/server.py']:
                    self.assertEqual(get(path)[0], 404)
                (root / 'new.mp3').write_bytes(b'abc')
                self.assertEqual(len(json.loads(get('/api/tracks')[2])), 2)
                lyric_url = url.replace('/media/', '/lyrics/')
                status, headers, body = get(lyric_url)
                self.assertEqual(status, 200)
                self.assertEqual(body.decode('utf-8').splitlines(), ['[00:01.000]你好', '[00:02.50]世界'])
                self.assertEqual(headers['Content-Type'], 'text/plain; charset=utf-8')
                self.assertEqual(get(lyric_url, method='HEAD')[2], b'')
                (lyrics / '歌曲 #1.lrc').write_bytes('[00:01.00]中文歌词'.encode('gb18030'))
                self.assertEqual(get(lyric_url)[2].decode('utf-8'), '[00:01.00]中文歌词')
                self.assertEqual(get('/lyrics/new.mp3')[0], 404)
                (lyrics / 'new.translation.lrc').write_text('[00:01.00]prefix', encoding='utf-8')
                self.assertEqual(get('/lyrics/new.mp3')[2], b'[00:01.00]prefix')
                (lyrics / 'new.other.lrc').write_text('ambiguous', encoding='utf-8')
                self.assertEqual(get('/lyrics/new.mp3')[0], 404, 'Ambiguous prefix must not guess')
                (root / 'double.mp3.mp3').write_bytes(b'abc')
                (lyrics / 'double.lrc').write_text('[00:00]double suffix', encoding='utf-8')
                self.assertEqual(get('/lyrics/double.mp3.mp3')[2], b'[00:00]double suffix')
                (root / 'prefix.mp3').write_bytes(b'abc')
                (lyrics / 'prefix翻译版.lrc').write_text('[00:00]unique prefix', encoding='utf-8')
                self.assertEqual(get('/lyrics/prefix.mp3')[2], b'[00:00]unique prefix')
                (root / 'Song.mp3').write_bytes(b'abc')
                (lyrics / 'Song.lrc').write_text('[00:00]literal', encoding='utf-8')
                (lyrics / 'song.lrc').write_text('[00:00]different case', encoding='utf-8')
                if len([p for p in lyrics.iterdir() if p.stem.casefold() == 'song']) == 2:
                    self.assertEqual(get('/lyrics/Song.mp3')[2], b'[00:00]literal')
                for path in ['/lyrics/..%2Fprivate.txt', '/lyrics/private.txt', '/lyrics/missing.mp3']:
                    self.assertEqual(get(path)[0], 404)
                (root / 'link.mp3').write_bytes(b'abc')
                try:
                    (lyrics / 'link.lrc').symlink_to(root / 'private.txt')
                except OSError:
                    pass  # Windows may require an extra privilege for symlinks.
                else:
                    self.assertEqual(get('/lyrics/link.mp3')[0], 404)
            finally:
                process.terminate()
                process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
