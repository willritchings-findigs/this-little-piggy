#!/usr/bin/env python3
"""
Upload the built dashboard to the GTM Leadership Dashboard Drive folder (config.distribution.gdrive_folder_id)
with a Drive API v3 resumable upload, as a Google service account. Spec: publish_spec.md.

The file never passes through a model tool call, so its size doesn't matter. On success the file's webViewLink is
the only thing printed to stdout; the skill uses it to fill <DRIVE_LINK> in output/slack_post.txt.

Credential: env GTM_DASHBOARD_SA_KEY = the service-account JSON key itself, or a path to it. Never stored in the repo.
Scope: drive.file. The service account must be a Content Manager member of the Shared Drive (not just the folder).

Exit 0 = uploaded (link on stdout) · 5 = not configured (no credential / google-auth missing) · 6 = upload failed,
including a file of that name already in the folder (each week is its own file; this never overwrites one).

Usage: python publish.py [--check] [output/findigs_gtm_executive_dashboard_YYYY-MM-DD.html]
  --check   authenticate and confirm the folder is reachable, upload nothing
"""
import argparse, glob, json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
API = "https://www.googleapis.com/drive/v3"
UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
CHUNK = 8 * 256 * 1024          # Drive requires chunk sizes in multiples of 256 KiB
RETRIES = 4                     # per request, on 429 / 5xx / connection errors, backoff 2s, 4s, 8s, 16s
ENV = "GTM_DASHBOARD_SA_KEY"


class NotConfigured(Exception): pass
class UploadFailed(Exception): pass


def session_from_env():
    raw = os.environ.get(ENV, "").strip()
    if not raw: raise NotConfigured(f"{ENV} is not set")
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
    except (Exception, BaseException) as e:  # ImportError, or a broken native dependency (pyo3 PanicException)
        if isinstance(e, (KeyboardInterrupt, SystemExit)): raise
        raise NotConfigured(f"google-auth could not load ({type(e).__name__}); run pip install -r requirements.txt")
    try:
        info = json.loads(raw) if raw.startswith("{") else json.load(open(raw))
        creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    except (OSError, ValueError, KeyError) as e:
        raise NotConfigured(f"{ENV} is not a readable service-account key: {type(e).__name__}: {e}")
    return AuthorizedSession(creds)


def call(s, method, url, ok=(200,), **kw):
    """One HTTP request with bounded retries on transient errors. Returns the response for any status in ok."""
    for attempt in range(RETRIES + 1):
        try:
            r = s.request(method, url, timeout=60, **kw)
        except Exception as e:  # connection reset, DNS, timeout
            if attempt == RETRIES: raise UploadFailed(f"{method} {url.split('?')[0]}: {type(e).__name__}: {e}")
        else:
            if r.status_code in ok: return r
            if r.status_code not in (429, 500, 502, 503, 504) or attempt == RETRIES:
                raise UploadFailed(f"{method} {url.split('?')[0]}: HTTP {r.status_code}: {r.text[:300]}")
        time.sleep(2 ** (attempt + 1))


def check_folder(s, folder_id):
    r = call(s, "GET", f"{API}/files/{folder_id}", params={"supportsAllDrives": "true", "fields": "id,name,mimeType,driveId"})
    meta = r.json()
    if meta.get("mimeType") != "application/vnd.google-apps.folder": raise UploadFailed(f"{folder_id} is not a folder")
    return meta


def existing(s, folder_id, name):
    q = f"name = '{name}' and '{folder_id}' in parents and trashed = false"
    r = call(s, "GET", f"{API}/files", params={"q": q, "supportsAllDrives": "true", "includeItemsFromAllDrives": "true",
                                                 "corpora": "allDrives", "fields": "files(id,webViewLink)"})
    return r.json().get("files", [])


def upload(s, path, folder_id):
    name, size = os.path.basename(path), os.path.getsize(path)
    if (dupe := existing(s, folder_id, name)):
        raise UploadFailed(f"{name} already exists in the folder ({dupe[0].get('webViewLink')}); not overwriting")
    r = call(s, "POST", UPLOAD, params={"uploadType": "resumable", "supportsAllDrives": "true"},
             headers={"X-Upload-Content-Type": "text/html", "X-Upload-Content-Length": str(size),
                      "Content-Type": "application/json; charset=UTF-8"},
             data=json.dumps({"name": name, "parents": [folder_id], "mimeType": "text/html"}))
    session_url = r.headers.get("Location")
    if not session_url: raise UploadFailed("resumable upload session was not opened (no Location header)")
    with open(path, "rb") as f:
        sent = 0
        while True:
            f.seek(sent); chunk = f.read(CHUNK); end = sent + len(chunk) - 1
            r = call(s, "PUT", session_url, ok=(200, 201, 308), data=chunk,
                     headers={"Content-Range": f"bytes {sent}-{end}/{size}", "Content-Length": str(len(chunk))})
            if r.status_code in (200, 201): break
            rng = r.headers.get("Range")       # 308: Drive says how much it has; resume from there
            sent = int(rng.split("-")[1]) + 1 if rng else 0
    file_id = r.json()["id"]
    meta = call(s, "GET", f"{API}/files/{file_id}", params={"supportsAllDrives": "true", "fields": "id,webViewLink,size"}).json()
    if int(meta.get("size", size)) != size: raise UploadFailed(f"uploaded size {meta.get('size')} != local size {size}")
    return meta["webViewLink"]


def main(argv=None, session=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?")
    ap.add_argument("--check", action="store_true", help="authenticate and confirm folder access; upload nothing")
    args = ap.parse_args(argv)
    cfg = json.load(open(os.path.join(HERE, "config.json")))["distribution"]
    folder = cfg["gdrive_folder_id"]
    try:
        s = session or session_from_env()
        if args.check:
            meta = check_folder(s, folder)
            print(f"OK  folder '{meta.get('name')}' ({folder}) reachable", file=sys.stderr); return 0
        path = args.path or sorted(glob.glob(os.path.join(HERE, "output", "findigs_gtm_executive_dashboard_*.html")))[-1]
        check_folder(s, folder)
        print(upload(s, path, folder))
        return 0
    except NotConfigured as e:
        print(f"NOT CONFIGURED: {e}", file=sys.stderr); return 5
    except UploadFailed as e:
        print(f"UPLOAD FAILED: {e}", file=sys.stderr); return 6


if __name__ == "__main__":
    sys.exit(main())
