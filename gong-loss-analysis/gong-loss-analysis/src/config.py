"""Shared paths and settings. Credentials come ONLY from environment / .env — never hardcode or print them."""
import os
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
# Point GONG_ENV_PATH at the existing .env (e.g. C:\Users\Will Ritchings\Desktop\Claude\.env) or put a .env in the project root.
load_dotenv(os.environ.get("GONG_ENV_PATH", ROOT / ".env"))

DATA = ROOT / "data"
RAW = DATA / "raw"                 # raw Gong payloads + transcripts: LOCAL ONLY, gitignored, contains PII
PREPARED = DATA / "prepared"       # redacted, role-tokenised transcripts: still sensitive, gitignored
CODED = DATA / "coded"             # LLM codings (no raw transcript text; evidence quotes ≤25 words, redacted)
OUT = DATA / "outputs"
REPORTS = ROOT / "reports"
SCHEMA = ROOT / "schema"
PROMPTS = ROOT / "prompts"
for p in [RAW, RAW / "calls_extensive", RAW / "transcripts", PREPARED, CODED / "calls", CODED / "deals", CODED / "reliability", OUT, REPORTS]:
    p.mkdir(parents=True, exist_ok=True)

COHORT = DATA / "cohort_deals.csv"
FINDINGS = DATA / "paper_findings_register.csv"
ROSTER = DATA / "internal_roster.csv"
DEAL_ASSOC = DATA / "deal_associations.csv"   # built in Phase 1 from HubSpot (company domains, contact emails, legacy SF opp id)

GONG_BASE_URL = os.environ.get("GONG_BASE_URL", "https://api.gong.io").rstrip("/")
GONG_MAX_RPS = float(os.environ.get("GONG_MAX_RPS", "2.5"))         # Gong limit is 3/sec account-wide; stay under it
GONG_DAILY_BUDGET = int(os.environ.get("GONG_DAILY_BUDGET", "6000"))  # Gong limit is 10,000/day account-wide; leave headroom for other integrations

ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")
ANTHROPIC_RELIABILITY_MODEL = os.environ.get("ANTHROPIC_RELIABILITY_MODEL", "claude-opus-5-5")

# Matching window around each deal (days)
WINDOW_BEFORE_CREATE = int(os.environ.get("WINDOW_BEFORE_CREATE", "14"))
WINDOW_AFTER_CLOSE = int(os.environ.get("WINDOW_AFTER_CLOSE", "7"))
MIN_MEETING_SECONDS = int(os.environ.get("MIN_MEETING_SECONDS", "120"))

# Sample-size thresholds (same as the loss-analysis workbook Parameters tab)
N_REPORTABLE = 30
N_DIRECTIONAL = 10
MIGRATION_DATE = "2026-07-14"

FREEMAIL = {"gmail.com","yahoo.com","outlook.com","hotmail.com","aol.com","icloud.com","me.com","live.com","msn.com","comcast.net","protonmail.com"}
