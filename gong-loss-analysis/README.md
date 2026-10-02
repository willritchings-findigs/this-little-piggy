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
- No Anthropic API key. All LLM coding runs in Claude Code subagents (`.claude/agents/`) under your Claude account.

## Pipeline (run order — each step runs once, in bulk; no Anthropic API key needed)

| Phase | Step | Script / agent | Output | Checkpoint |
|---|---|---|---|---|
| 0 | Verify endpoints, roster, ICP context, subagents | `src/00_setup_check.py --probe`, `/agents`, `/status` | Probe structures | CP0 |
| 1 | Light Gong metadata, all calls in window | `src/01_pull_calls.py` | `data/raw/calls_extensive/` | |
| 1 | HubSpot associations, all 845 deals (≈25 batch requests) | `src/01b_build_associations.py` | `data/deal_associations.csv` | |
| 1 | Match calls → deals; apply scope rules 1–3; coverage, bias, cost | `src/02_match_calls.py`, `src/03_coverage_report.py` | `reports/01_coverage_report.md` (incl. scope waterfall) | **CP1** |
| 2 | Content + transcripts (100 per request) | `src/04_pull_content.py` | `data/raw/calls_content/`, `transcripts/` | |
| 2 | Redact + leak scan | `src/05_prepare_transcripts.py` | `data/prepared/` | |
| 2 | **Rule 4:** at most 3 calls per deal, one random call per funnel section | `src/05a_select_calls.py` | `selected_calls.csv` | |
| 2 | **Tier A** deterministic features (all in-scope calls) + Tier B brief bundles (selected calls) | `src/05b_tier_a_features.py` | `tierA_call_features.csv`, `data/prepared/briefs/` | |
| 2 | **Tier C** sample design + calibration set | `src/05c_select_sample.py` | `reports/01b_sample_design.md` | **CP1b** |
| 3 | Calibration (primary + independent pass) | `src/10_agent_packets.py` → `call-coder` subagents | `data/coded/calls`, `reliability` | |
| 3 | Human packet + κ gate | `src/08_reliability_check.py --packet` / `--score` | `reports/02_reliability.md` | **CP2** |
| 4 | **Tier B** brief coding (all deals with briefs) | `brief-coder` subagents | `data/coded/briefs/` | |
| 4 | **Tier C** call coding, then deal synthesis | `call-coder`, then `deal-synthesizer` subagents | `data/coded/calls`, `deals` | |
| 5 | Three-tier analysis with per-tier validity gates | `src/09_analyze.py` | `reports/03`–`05` | **CP3** |
| 6 | Paper revision + rebuild | `docs/reference/paper_source/` | v2 paper | **CP4** |

### Scope rules (Will, 2026-10-01)

1. **Window.** Only calls dated between the deal's create date and close date (local calendar days).
2. **Sales process only.** A deterministic relevance filter. Uncertain calls are excluded by default.
3. **Length.** Only calls of 120 seconds or longer.
4. **Cap for LLM reading.** At most 3 calls per deal, one random call per funnel section reached. Applies to Tier B and Tier C only; Tier A uses every in-scope call, at no token cost.
5. **Intro-only deals** (never advanced past Intro & Challenge, 337 deals, all lost):
   - excluded from Tier B;
   - capped at a fixed 30 deals × 1 call in Tier C, enough for a reportable died-at-Intro vs advanced comparison;
   - fully covered by Tier A.

### Evidence tiers

- **A — deterministic, every covered deal.** Regex and metadata features. Free to run. Each proxy is validated against Tier C before it can be reported.
- **B — Gong AI briefs, every deal that has them.** Light LLM coding, done by subagents. Validated against Tier C on the deals the two tiers share.
- **C — full transcripts, designed sample** (all covered wins plus stratified lost deals, with Mid-Market oversampled). Deep coding plus deal synthesis. Weighted by coverage × sampling weights. Gated by calibration κ and human review.

## Design guarantees

- **Blind coding.** The LLM coder never sees a deal's outcome or CRM loss reason.
- **One deal, one vote.** Results are aggregated to one row per deal before any rates are calculated.
- **Won-deal control.** Every loss pattern is shown alongside its prevalence in won deals.
- **Comparable frames.** Won and lost deals are compared only within the same funnel stage reached.
- **Coverage bias handled explicitly.** The pipeline runs chi-square tests on coverage, applies IPW weights, and flags strata it cannot represent.
- **Sample-size labels.** Findings are labeled reportable (n ≥ 30), directional (n 10–29), or anecdotal (n < 10, quotes only).
- **Multiple-comparison correction.** BH-FDR q-values are reported.
- **Coding reliability gate, before production.** A fixed 30-call calibration set is coded twice by independent subagents (κ is calculated), and Will reviews 20 of those calls by hand. Human review is mandatory because both passes are the same model. The prompt is frozen before production, so a failed field never forces a full recode.
- **Cost controls.**
  - Two-tier Gong pull: heavy content fetched only for matched meetings.
  - Batch HubSpot reads.
  - Deterministic Tier A, with cheap Tier B run first.
  - Deep coding only on a weighted sample.
  - Packet-sized subagents that return one line each.
  - Version-aware skipping, so nothing is coded twice.
- **Validated subagent output.** Every subagent output passes `validate_coding.py` before ingest: schema, no PII patterns, quotes of 25 words or fewer, version stamp.
- **PII stays local.** Raw data and transcripts are gitignored. Report quotes are 25 words or fewer, redacted, and attributed by role token only.

## Offline smoke test

The scripts were tested end to end on synthetic data. They have not been run against the live Gong API. Phase 0 verifies field names against a real response.

```bash
cp -r gong-loss-analysis /tmp/gl_test && cd /tmp/gl_test
echo "Mock ICP" > prompts/icp_persona_context.md
python tests/make_mock_data.py && python src/02_match_calls.py && python src/03_coverage_report.py && python src/05_prepare_transcripts.py && python src/05a_select_calls.py && python src/05b_tier_a_features.py && python src/05c_select_sample.py && python tests/mock_agents.py && python src/08_reliability_check.py --packet && python src/08_reliability_check.py --score && python src/09_analyze.py
```

Never run the mock scripts in the real project folder. They overwrite the roster and associations.
