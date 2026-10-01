# gong-loss-analysis

Qualitative extension of the Findigs New Logo loss analysis. This project analyzes Gong call transcripts for the same 845 closed deals (Oct 2025 – Sep 2026) in order to validate, contradict, or supplement the findings in *Why and Where We Lose New Logo Deals*, and then to polish that paper.

**Start here:** open Claude Code in this folder and paste in `CLAUDE_CODE_PROMPT.md`. It runs in phases, with a checkpoint at the end of each one.

## Setup (Windows PowerShell)

```powershell
cd <repo>\this-little-piggy\gong-loss-analysis
python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:GONG_ENV_PATH = "C:\Users\Will Ritchings\Desktop\Claude\.env"   # or copy .env.example -> .env
```

The `.env` file needs these variables:

- `GONG_ACCESS_KEY` and `GONG_ACCESS_KEY_SECRET`
- `HUBSPOT_ACCESS_TOKEN`, a read-only private-app token for the batch association build
- `ANTHROPIC_API_KEY`, used for LLM coding (there is an agent-mode fallback if you don't have one)

## Pipeline (run order — each step runs once, in bulk)

| Phase | Step | Script | Output | Checkpoint |
|---|---|---|---|---|
| 0 | Verify all endpoints, roster, ICP context | `src/00_setup_check.py --probe` | Probe structures, roster Gong IDs | CP0 |
| 1 | Light Gong metadata, all calls in window | `src/01_pull_calls.py` | `data/raw/calls_extensive/*.jsonl` | |
| 1 | HubSpot associations, all 845 deals (≈25 batch requests) | `src/01b_build_associations.py` | `data/deal_associations.csv` | |
| 1 | Match calls → deals | `src/02_match_calls.py` | `data/outputs/call_deal_map.csv` | |
| 1 | Coverage, bias tests, cost forecast | `src/03_coverage_report.py` | `reports/01_coverage_report.md` | **CP1** |
| 2 | Content + transcripts for in-scope meetings (100 per request) | `src/04_pull_content.py` | `data/raw/calls_content/`, `data/raw/transcripts/` | |
| 2 | Redact, role-tokenize, automated leak scan | `src/05_prepare_transcripts.py` | `data/prepared/`, `redaction_leak_scan.csv` | |
| 3 | Calibration: 60 calls × 2 models | `src/06_code_calls.py --calibration 60` | `data/coded/calls`, `data/coded/reliability` | |
| 3 | Human packet + κ gate | `src/08_reliability_check.py --packet` / `--score` | `reports/02_reliability.md` | **CP2** |
| 4 | Production coding (Batch API, cached prompt) | `src/06_code_calls.py --all --batch`, then `--collect` | `data/coded/calls/` | |
| 4 | Deal synthesis (Batch API) | `src/07_synthesize_deals.py --batch`, then `--collect` | `data/coded/deals/` | |
| 5 | All pre-registered tests | `src/09_analyze.py` | `reports/03`–`05` | **CP3** |
| 6 | Paper revision + rebuild | `docs/reference/paper_source/` | v2 paper | **CP4** |

## Design guarantees

- **Blind coding.** The LLM coder never sees a deal's outcome or CRM loss reason.
- **One deal, one vote.** Results are aggregated to one row per deal before any rates are calculated.
- **Won-deal control.** Every loss pattern is shown alongside its prevalence in won deals.
- **Comparable frames.** Won and lost deals are compared only within the same funnel stage reached.
- **Coverage bias handled explicitly.** The pipeline runs chi-square tests on coverage, applies IPW weights, and flags strata it cannot represent.
- **Sample-size labels.** Findings are labeled reportable (n ≥ 30), directional (n 10–29), or anecdotal (n < 10, quotes only).
- **Multiple-comparison correction.** BH-FDR q-values are reported.
- **Coding reliability gate, before production.** A fixed 60-call calibration set is coded by two models (κ is calculated), and Will reviews 20 calls by hand. The prompt is frozen before the full run, so a failed field never forces a full recode.
- **Cost controls.** Two-tier Gong pull (heavy content fetched only for matched meetings), batch HubSpot reads, the Message Batches API with prompt caching, and version-aware skipping so nothing is coded twice.
- **PII stays local.** Raw data and transcripts are gitignored. Report quotes are 25 words or fewer, redacted, and attributed by role token only.

## Offline smoke test

The scripts were tested end to end on synthetic data. They have not been run against the live Gong API. Phase 0 verifies field names against a real response.

```bash
cp -r gong-loss-analysis /tmp/gl_test && cd /tmp/gl_test
python tests/make_mock_data.py && python src/02_match_calls.py && python src/03_coverage_report.py && python src/05_prepare_transcripts.py && python tests/mock_code.py && python src/08_reliability_check.py --packet && python src/08_reliability_check.py --score && python src/09_analyze.py
```

Never run the mock scripts in the real project folder. They overwrite the roster and associations.
