#!/usr/bin/env python3
"""Offline tests for publish.py against a fake Drive API. Run: python test_publish.py (exit 0 = all pass)."""
import os, sys, tempfile, unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import publish

FOLDER = "1uxooqagOt5pmyOKYjrH3ZLf9wjhNRuoX"


class Resp:
    def __init__(self, status, body=None, headers=None):
        self.status_code, self._body, self.headers = status, body or {}, headers or {}
        self.text = str(self._body)
    def json(self): return self._body


class FakeDrive:
    """Just enough of Drive v3: folder GET, files list, resumable POST + chunked PUT, file GET."""
    def __init__(self, existing=(), fail_first_put=False, drop_bytes=0):
        self.files, self.received, self.existing = {}, b"", list(existing)
        self.fail_first_put, self.drop_bytes, self.puts = fail_first_put, drop_bytes, 0
    def request(self, method, url, params=None, headers=None, data=None, timeout=None):
        if method == "GET" and url.endswith(f"/files/{FOLDER}"):
            return Resp(200, {"id": FOLDER, "name": "GTM Leadership Dashboard", "mimeType": "application/vnd.google-apps.folder"})
        if method == "GET" and url.endswith("/files"):
            assert params["supportsAllDrives"] == "true"
            return Resp(200, {"files": [{"id": "old", "webViewLink": "https://drive/old"}] if self.existing else []})
        if method == "POST" and url == publish.UPLOAD:
            assert params == {"uploadType": "resumable", "supportsAllDrives": "true"}
            self.size = int(headers["X-Upload-Content-Length"])
            return Resp(200, headers={"Location": "https://upload/session/1"})
        if method == "PUT" and url == "https://upload/session/1":
            self.puts += 1
            if self.fail_first_put and self.puts == 1: return Resp(503)
            start = int(headers["Content-Range"].split()[1].split("-")[0])
            assert start == len(self.received), "chunk must resume where Drive left off"
            keep = data[:len(data) - self.drop_bytes] if self.drop_bytes and self.puts == 1 else data
            self.received += keep
            if len(self.received) < self.size: return Resp(308, headers={"Range": f"bytes=0-{len(self.received) - 1}"})
            self.files["new"] = self.received
            return Resp(201, {"id": "new"})
        if method == "GET" and url.endswith("/files/new"):
            return Resp(200, {"id": "new", "webViewLink": "https://drive/new", "size": str(len(self.files["new"]))})
        raise AssertionError(f"unexpected {method} {url}")


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile("wb", suffix=".html", delete=False)
        self.payload = os.urandom(publish.CHUNK * 2 + 12345)   # three chunks, the last one partial
        self.tmp.write(self.payload); self.tmp.close()
        mock.patch.object(publish.time, "sleep", lambda s: None).start()
    def tearDown(self):
        mock.patch.stopall(); os.unlink(self.tmp.name)

    def run_main(self, drive, *extra):
        return publish.main([*extra, self.tmp.name], session=drive)

    def test_chunked_upload_prints_link(self):
        d = FakeDrive()
        with mock.patch("builtins.print") as p:
            self.assertEqual(self.run_main(d), 0)
        self.assertEqual(d.files["new"], self.payload)
        p.assert_called_with("https://drive/new")

    def test_resumes_from_drive_range_after_partial_chunk(self):
        d = FakeDrive(drop_bytes=1000)
        self.assertEqual(self.run_main(d), 0)
        self.assertEqual(d.files["new"], self.payload)

    def test_transient_503_is_retried(self):
        d = FakeDrive(fail_first_put=True)
        self.assertEqual(self.run_main(d), 0)
        self.assertEqual(d.files["new"], self.payload)

    def test_never_overwrites_existing_week(self):
        d = FakeDrive(existing=["x"])
        self.assertEqual(self.run_main(d), 6)
        self.assertNotIn("new", d.files)

    def test_check_uploads_nothing(self):
        d = FakeDrive()
        self.assertEqual(publish.main(["--check"], session=d), 0)
        self.assertEqual(d.files, {})

    def test_missing_credential_is_not_configured(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(publish.main([self.tmp.name]), 5)

    def test_unreadable_credential_is_not_configured(self):
        with mock.patch.dict(os.environ, {publish.ENV: "/nonexistent/key.json"}):
            self.assertEqual(publish.main([self.tmp.name]), 5)


if __name__ == "__main__":
    unittest.main(verbosity=1)
