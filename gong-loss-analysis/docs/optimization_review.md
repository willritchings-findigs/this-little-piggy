# Optimization review: process flow (v1.0 → v1.1)

**Reviewed:** 2026-10-01, before handoff to Claude Code.

**Scope:** order of operations, token cost, compute and API time, duplicate work, and rework loops. This covers the prompt, the scripts, and the supporting docs.

## Target flow

Each step runs once, in bulk, and reads from the step before it.

```
P0  Verify every endpoint shape on 3 real calls, roster, ICP context ............................ CP0
P1  Bulk: light Gong metadata (all calls) ║ HubSpot associations (all 845 deals, batch)
    → match calls to deals → coverage, bias, and cost forecast ...................................... CP1 (scope + cost)
P2  One pass: content + transcripts for in-scope meetings only (100 per request) → redact + leak scan
P3  Calibration: fixed 60 calls × 2 models + 20-call human review → κ gate; iterate on these 60 only ... CP2 (freeze prompt)
P4  Production: Batch API + cached prompt → collect (sync retry of failures) → deal synthesis (batch)
P5  Analysis: every pre-registered test already scripted → register + findings ......................... CP3
P6  Paper revision + rebuild ............................................................................ CP4
```

## Issues found and fixes

| # | Issue in v1.0 | Impact | Fix in v1.1 |
|---|---|---|---|
| 1 | Reliability was checked **after** the full coding run. | A failed field (κ < 0.40) would force recoding the entire corpus. This was the largest rework risk in the package. | Phase 3 calibration on a fixed 60-call set, coded by both models, plus human review, **before** production. The prompt is frozen at CP2, so production runs once. |
| 2 | The pilot (25 calls) and the reliability sample were separate sets, with separate review loops. | Two review cycles, and pilot results weren't comparable across prompt iterations. | Merged into one fixed calibration set (`calibration_calls.csv`), reused across iterations for like-for-like comparison. One checkpoint (CP2) instead of two. |
| 3 | The HubSpot association step was unscripted ("use MCP or API"). | Claude Code would likely loop per deal: 845 deals × associations + objects ≈ 2,500+ tool calls. | `01b_build_associations.py` uses batch endpoints, about 25 requests total. The legacy Salesforce ID property is auto-detected. If only MCP is available, the prompt forbids per-deal fallback and asks for a token instead. |
| 4 | The metadata pull requested **full content** (brief, topics, trackers, interaction stats) for every Gong call in the account, including CS and support calls. | The largest Gong payload, mostly for calls that never match a deal. | Two-tier pull. The light tier covers all calls with parties and CRM context only. The content tier is fetched only for matched meetings. |
| 5 | Content and transcripts were fetched in separate passes (content in 01, transcripts in 04), with transcripts at 50 call IDs per request. | Redundant passes; twice as many transcript requests. | `04_pull_content.py` fetches both in one pass at 100 call IDs per request. |
| 6 | The Phase 0 probe checked only the metadata shape. | Content and transcript field-name errors would surface in Phase 2, after matching and coverage were already done. | The probe now verifies all three endpoint shapes on 3 real calls before any bulk pull. |
| 7 | LLM coding ran as synchronous, uncached requests. The transcript sat mid-prompt, so caching wasn't possible. | Highest dollar cost of the project. | The prompt is restructured: the static system prompt (instructions, ICP, rules) and the tool schema are cached, and only metadata and transcript vary. Production uses the Message Batches API. Sync is kept for calibration and retries. |
| 8 | No version tracking on codings. A prompt change meant manually deleting outputs, with a risk of mixing versions. | Rework, and silent contamination of κ and analysis with mixed prompt versions. | Every coding records `prompt_version`. Scripts treat a coding as done only under the current version, so a prompt edit re-queues exactly the stale items. Reliability scores only current-version codings. |
| 9 | Redaction was "strengthen if needed after eyeballing 10 files". | A manual loop, with transcript text pulled into Claude Code's context (token cost and PII). | 05 automatically adds deal company names, contact names, and deal-name stems from the associations file, then writes an automated leak scan. Claude Code reads the scan, not the transcripts. |
| 10 | Five analyses (T3, T9, the RQ3 question inventory, RQ7 agreement scoring, split-half replication) were left as "extend 09 as needed". | Claude Code writing new statistical code mid-analysis: token cost, and a risk of guardrails being applied inconsistently. | All five are implemented in `09_analyze.py` with the same guardrails (one deal one vote, won control, BH-FDR, reliability gate, concentration). |
| 11 | No cost or volume forecast before committing to transcript pulls and coding. | Scope decided without knowing the cost. | The coverage report (CP1) now includes in-scope meetings, total minutes, Gong request estimate, and transcript-token estimate. |

## Also fixed during testing

- **ICP placeholder bug.** The placeholder file's own TODO comment contained the template token, so every coding prompt would have shipped with an unfilled placeholder. Comments are now stripped before injection, and coding refuses to start while the Phase 0 TODO is present.
- **New execution principles in the prompt.** These cover bulk-only operations, no transcripts in Claude Code's context, run-once-in-order, verify before spending, calibrate before production, and cheapest execution path.

## Testing

- **Offline smoke test.** The full chain (02 → 03 → 05 → mock coding → 08 → 09) passes on synthetic data.
- **LLM paths (`tests/test_llm_paths.py`, with the Anthropic client mocked).** Verified:
  - Calibration codes 30 calls with both models.
  - Production batches exactly the non-calibration calls, so there is no double coding.
  - Simulated batch failures are retried through the sync path.
  - A second submit queues nothing (idempotent).
  - Deal synthesis completes in batch mode.
  - The static prompt carries the cache-control flag, and no placeholders are left unfilled.
- **Not testable here:** live Gong, HubSpot, and Anthropic endpoints. Phase 0 exists to verify those before any bulk spend.

## Decisions left to Will

- **Pull floor.** Only 8 of the 845 deals were created before 2025, but they set the pull start at April 2023. The light pull for the extra 20 months is cheap, so v1.1 keeps it. If Gong volume before 2025 turns out to be large at CP1, pass `--from 2024-12-15` to `01_pull_calls.py` and accept partial history for those 8 deals.
- **Calibration size.** 60 calls by default (`--calibration N`). Raise it if CP1 shows many thin strata.

## v2.0 addendum: agent mode (no Anthropic API key)

| Change | Why |
|---|---|
| LLM coding moved from API scripts to Claude Code subagents (`.claude/agents/`), driven by `10_agent_packets.py` work packets | No API key. Each subagent codes about 45k tokens of transcript in a fresh context and returns one line, so the main session's context stays small. |
| New Tier A (`05b`): deterministic features on every meeting | Answers price timing, competitors, terms, friction and gaps for all covered deals at no LLM cost |
| New Tier B: subagent coding of Gong AI briefs | Briefs are roughly 40× shorter than transcripts, so momentum and driver coding covers every deal cheaply |
| Tier C (`05c`): deep coding limited to a designed, weighted sample (about 200 deals, 6 or fewer meetings each) | Keeps subagent effort within plan usage while preserving won-vs-lost power |
| Tier A and B gated by agreement with Tier C | Cheap proxies are reportable only once validated |
| `validate_coding.py`: staging → validation → ingest | Subagents can't write malformed, mis-versioned, PII-bearing, or over-long-quote output into the dataset |
| Checkpoint 1b: approve the sample and effort before any coding | Effort is visible and agreed before the expensive work begins |
| Brief bundles built in the same local pass as Tier A | No extra reading pass |
| Shared redaction module (`redact.py`) | Transcripts and briefs are redacted identically |
| Fixed during testing: `groupby().apply()` dropping grouping columns in current pandas (calibration sampling) | Would have crashed `05c` and the optional API path in Claude Code |
| Tested: `tests/mock_agents.py` runs the real packet → staging → validate → ingest path for all five kinds, including deliberately broken outputs that must be rejected and fixed | — |

## v2.1 addendum: scope rules and token reduction

| Change | Effect on mock data (1,539 Gong calls, 845 deals) |
|---|---|
| Rule 1: strict create-to-close window, on local dates (was −14 / +7 days) | 90 matched calls removed |
| Rule 3: calls of 120 seconds or longer, applied before anything else downstream | 132 removed |
| Rule 2: deterministic sales-relevance filter; uncertain calls excluded by default | 103 removed (internal-only, post-sale CS) |
| Rule 4: one random call per funnel section, at most 3 per deal, no fill by default | LLM-read pool: 554 selected calls out of 1,084 in scope (−49%). Tier C: 279 transcripts, down from 499 with fill and 452 under the old cap of 6 |
| Turn-merged transcripts (one line per speaker turn) | About 19% fewer transcript characters on a realistic turn pattern |
| Scope verified against ground truth | 1,409 matched calls, 0 misclassified |
| Fixed: `05` now enforces in-scope itself instead of relying on `04` | Prevented a crash on out-of-scope transcripts |
| Subagent inputs carry real gaps (to the previous in-scope meeting) | Prevents the cap from fabricating "silence" |
| `cap_sensitivity` tab (Tier A on all calls vs selected calls) | Measures whether the cap biases won-vs-lost comparisons |

## v2.2 addendum: rule 5 (Intro-only deals), Option 2

- **Tier B.** Deals that never left Intro are excluded. On mock data that removes about 26% of brief text.
- **Tier C.** These deals are capped at a fixed 30, down from a proportional 56. That is about 26 fewer transcripts, roughly a 10% reduction. The Discovery-or-later lost target is set independently (`--opp-lost-target 115`), so the freed slots are not reallocated.
- **Fixed during testing.** The T1 frame had excluded deals whose Intro call was a no-show. It now includes them, because no-shows are the evidence.
- **Kept.** Tier A covers all 337 deals at no token cost.
- **New analysis tabs.** `t1_intro_calls`, `t1_intro_personas` and `t1_intro_by_source` compare Intro calls of deals that died at Intro with those that advanced. This tests H01 / Priority 1 at reportable n.
- **Not chosen:** full exclusion (about a 20% saving), because it would have removed the evidence for the funnel's largest leak.
