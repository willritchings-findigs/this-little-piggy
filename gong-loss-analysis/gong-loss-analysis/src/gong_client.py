"""Minimal Gong REST client: Basic Auth, throttling, retries, cursor pagination, daily request budget.
Verified endpoints (confirm against https://gong.app.gong.io/settings/api/documentation in Phase 0):
  GET  /v2/users                 (cursor pagination)
  POST /v2/calls/extensive       (filter + contentSelector; cursor in body)
  POST /v2/calls/transcript      (filter.callIds; cursor in body)
"""
import base64, json, os, time, datetime as dt
import requests
from config import GONG_BASE_URL, GONG_MAX_RPS, GONG_DAILY_BUDGET, RAW

class GongError(RuntimeError):
    pass

class GongClient:
    def __init__(self):
        key = os.environ.get("GONG_ACCESS_KEY")
        secret = os.environ.get("GONG_ACCESS_KEY_SECRET")  # NOTE: not GONG_ACCESS_SECRET_KEY (Aug 2026 naming bug)
        if not key or not secret:
            raise GongError("GONG_ACCESS_KEY / GONG_ACCESS_KEY_SECRET not set. Check GONG_ENV_PATH or project .env (names are case-sensitive).")
        token = base64.b64encode(f"{key}:{secret}".encode()).decode()
        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Basic {token}", "Content-Type": "application/json"})
        self.min_interval = 1.0 / GONG_MAX_RPS
        self._last = 0.0
        self.budget_file = RAW / "request_budget.json"

    # ---- budget / throttle ----
    def _count(self):
        today = dt.date.today().isoformat()
        b = json.loads(self.budget_file.read_text()) if self.budget_file.exists() else {}
        n = b.get(today, 0) + 1
        if n > GONG_DAILY_BUDGET:
            raise GongError(f"Daily request budget ({GONG_DAILY_BUDGET}) reached. Resume tomorrow; scripts are resumable.")
        self.budget_file.write_text(json.dumps({today: n}))

    def _throttle(self):
        wait = self.min_interval - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()

    def request(self, method, path, json_body=None, params=None, max_retries=6):
        url = f"{GONG_BASE_URL}{path}"
        for attempt in range(max_retries):
            self._throttle(); self._count()
            r = self.s.request(method, url, json=json_body, params=params, timeout=120)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404 and "No calls found" in r.text:
                return {"records": {}, "calls": [], "callTranscripts": []}
            if r.status_code == 429:
                time.sleep(float(r.headers.get("Retry-After", 2 ** attempt)))
                continue
            if r.status_code >= 500:
                time.sleep(2 ** attempt)
                continue
            if r.status_code in (401, 403):
                raise GongError(f"{r.status_code} from Gong — check key validity and scopes (api:calls:read:basic, api:calls:read:extensive, api:calls:read:transcript, api:users:read). Body: {r.text[:300]}")
            raise GongError(f"{r.status_code} {path}: {r.text[:500]}")
        raise GongError(f"Gave up after {max_retries} retries: {path}")

    def paginate_post(self, path, body, items_key):
        """Yields items across pages. Gong cursors are short-lived: consume pages promptly, never sleep long mid-loop."""
        cursor = None
        while True:
            b = dict(body)
            if cursor:
                b["cursor"] = cursor
            data = self.request("POST", path, json_body=b)
            for it in data.get(items_key, []) or []:
                yield it
            cursor = (data.get("records") or {}).get("cursor")
            if not cursor:
                break

    def paginate_get(self, path, items_key, params=None):
        params = dict(params or {})
        while True:
            data = self.request("GET", path, params=params)
            for it in data.get(items_key, []) or []:
                yield it
            cursor = (data.get("records") or {}).get("cursor")
            if not cursor:
                break
            params["cursor"] = cursor
