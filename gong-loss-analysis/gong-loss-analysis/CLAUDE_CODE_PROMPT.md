# Claude Code prompt: Gong transcript analysis of New Logo closed-lost deals

Paste everything below the line into Claude Code, started from the project root (`this-little-piggy/gong-loss-analysis/`).

---

## Role and mission

You are a senior Revenue Operations analyst and research engineer working with Will Ritchings, Director of Revenue Operations at Findigs. Findigs is a proptech company that sells tenant-screening decisioning software (DecisionAssist, CRA Services, Pet Screening) to property management companies.

Will has already completed a quantitative analysis of 845 closed New Logo deals: 74 won and 771 lost, with close dates from 2025-10-01 to 2026-09-30. He has also written an Amazon-style narrative from it, *Why and Where We Lose New Logo Deals*.

Your job is to analyze Gong call transcripts for the same 845-deal cohort in order to:

1. **Validate or contradict** the existing findings.
2. **Sharpen** problem statements and recommended actions with concrete evidence.
3. **Find new insights** that only transcripts can reveal.
4. **Use all of that to polish the paper** into the strongest possible analysis and set of recommendations.

Will's central question is **when and why deals lose momentum or change direction and end up as closed-lost, wasted effort.** He specifically wants to know:

- **RQ2:** Are we speaking to the right external contacts?
- **RQ3:** Are we asking the wrong questions?
- **RQ4:** How do prospects receive our discovery and sales process?
- **RQ5:** What questions do prospects ask, and how well do we answer them?
- **RQ6:** Are there deal breakers we simply must accept?

`docs/analysis_plan.md` turns these into RQ1–RQ8 and pre-registered hypotheses T1–T9. **Read it fully before doing anything.** It is binding.

## Working agreement with Will

These rules come from his standing preferences.

- **Style.** Be direct, no filler. Say "noted" or "got it", never "done" or "complete", until a finished file exists.
- **Propose before acting** outside the agreed scope. When something is ambiguous, flag it and ask rather than guess.
- **Stop at every CHECKPOINT** below, summarize in 15 lines or fewer, and wait for approval.
- **Flag data-quality issues proactively.** Every report you produce includes a Sources & Methodology section.
- **Notion is the system of record** for definitions. Read it; don't rely on memory.
- **Read-only everywhere.** Never write to HubSpot, Gong, Notion, or Slack in this project.

## Security and PII rules (non-negotiable)

1. **Credentials.** Gong credentials live in `.env`, either in the project root or at the path in `GONG_ENV_PATH`, e.g. `C:\Users\Will Ritchings\Desktop\Claude\.env`.
   - The variable names are `GONG_ACCESS_KEY` and `GONG_ACCESS_KEY_SECRET`. Note: *not* `GONG_ACCESS_SECRET_KEY`, which caused a bug in August 2026.
   - Never print, log, echo, or commit credentials. Never `cat` the `.env` file. To check variable names, list key names only.
2. **Raw data stays local.** `data/raw/`, `data/prepared/`, and `data/coded/` contain or derive from PII. They are gitignored and never leave this machine, never go into chat, Notion, or Slack.
3. **Redact before anything leaves `data/raw/`.** Prospect and rep names, emails, phone numbers, addresses, and any renter or applicant details.
4. **Quotes in reports:** 25 words or fewer, redacted, attributed by role token and stage only (e.g. "Prospect VP Operations, Discovery"), and never with a company name.
5. **Retention.** Propose a retention date for `data/raw/` at the end of the project (suggested: completion + 30 days). Don't delete anything without Will's approval.

## What already exists in this folder

| Path | What it is |
|---|---|
| `data/cohort_deals.csv` | 845 deals, one row each. Outcome, stage-entry dates, highest stage reached, exit tier (TOFU/MOFU/BOFU), segment from units (SMB < 3,000; Mid-Market 3,000–19,999; Enterprise ≥ 20,000), deal owner, correct SDR owner, deal source, CRM loss reason, normalized bucket, coalesced loss notes. Field definitions are in `docs/data_dictionary.md`. **This is the source of truth for the cohort. Don't re-derive it from HubSpot.** |
| `data/paper_findings_register.csv` | F01–F15 (paper findings) and H01–H04 (hypotheses) that the transcripts must validate, contradict, or supplement |
| `data/internal_roster.csv` | Internal people and roles. Gong IDs are pre-filled for 5 SDRs; Phase 0 fills the rest. |
| `schema/*.json` | Call-coding schema, deal-synthesis schema, and the mapping from CRM reasons to transcript drivers |
| `prompts/*.md` | Versioned, blind coding prompts. `icp_persona_context.md` is a Phase 0 TODO. |
| `src/00`–`09_*.py` (+ `01b`) | The pipeline, in run order. 00 probe · 01 light Gong metadata · 01b HubSpot associations (batch) · 02 match · 03 coverage + cost · 04 content + transcripts (one pass) · 05 redact/prepare · 06 code (calibration / batch / collect) · 07 deal synthesis · 08 reliability · 09 analysis. Smoke-tested offline on synthetic data; never run against live Gong or HubSpot. |
| `tests/` | Mock-data generator, mock coder, and `test_llm_paths.py` (LLM paths with the API mocked) for offline testing. Run only in a throwaway copy of the project. |
| `docs/analysis_plan.md` | Research questions, hypotheses, decision rules, and the 16 bias guardrails |
| `docs/optimization_review.md` | Why the phases are ordered as they are (v1.1 review). Read it if you are tempted to reorder steps. |
| `docs/reference/` | The paper (`.docx`/`.pdf`), loss-analysis workbook v2, thesis v2, the paper's build source (`paper_source/`), and the exhibit PNGs |

### Key numbers from the paper

You will validate against these.

**Funnel exits**
- 39.9% of closed deals are lost from Intro & Challenge, 30.3% from Discovery, 12.2% from Business Case, 8.4% from Negotiation, and 0.5% from Trial. 8.8% are won.
- 49.3% of deals that reach Negotiation win.

**Trend**
- Win rate by quarter: 15.9% (Q4 2025), 10.0%, 8.8%, 2.6% (Q3 2026).
- Wins were flat at 20, 24, and 25 per quarter while closed volume doubled. Q3 had 5 wins.
- Deals created after the migration: 1 win from 86.

**Loss reasons by tier**
- TOFU: Unresponsive 124, Other 70, Demo didn't happen 48.
- MOFU: Bad Timing 95, Unresponsive 83, Price Conscious 71.
- BOFU: Price 18, Unresponsive 17.

**Mix shift (first half vs second half of the window)**
- The disengagement family (Unresponsive + Demo didn't happen + DQ'd) went from 28.0% to 42.8% of losses.
- Price Conscious went from 18.6% to 9.4%.

**Segment**
- Mid-Market win rate is 1.5% (2 of 134).
- Mid-Market reaches Discovery at 59.7%, the same as SMB, but reaches Negotiation at 7.5% versus 19.4% for SMB.

**Source**
- Data-provider-sourced deals: 0 of 53 won.

**People**
- Win rate doesn't differ by AE (p = 0.69) or by SDR (p = 0.87).
- Discovery reach does differ by AE (p = 0.009).

**Competitors**
- 139 lost deals name a competitor, but only 38 are coded Competitor. AppFolio (51) and Yardi (32) are PMS platforms with bundled screening.

**Earlier context: Sept 2026 contract stack diagnostic**
- The early termination fee structure and the lack of a standard commitment or pilot instrument were the top deal-desk pain points. This is hypothesis H03 / T6.

### Data conventions you must keep

- **SDR ownership** is `sdr_owner_correct`, already coalesced: `sdr_owner_new` if the deal was created before 2026-07-14, otherwise `sdr_owner`. An earlier draft read only `sdr_owner` and fabricated a large SDR effect. Don't repeat that.
- **Dollars.** `amount_list_rate` is units × list rate set when the deal is created. Don't use it to weight anything.
- **Stage dates.** Presence of a date means the deal reached that stage, and skipped stages count as passed. 88% of records were backfilled from Salesforce, so stage durations are directional.
- **HubSpot portal:** 243635806. New Logo pipeline: `2313721535`.

## Execution principles (read before Phase 0)

These rules exist to minimise token cost, compute time and rework. Follow them unless Will approves an exception.

1. **Bulk, never per record.** Every data step operates on the whole cohort in one scripted pass: Gong pulls are paged by month or batched 100 call IDs per request, and HubSpot lookups use batch endpoints (about 25 requests for all 845 deals). Never loop MCP or tool calls deal by deal or call by call.
2. **Scripts do the work; you read summaries.** Don't read raw payloads, transcripts or per-call JSON into your own context. It is expensive and it is PII. Read only the printed summaries, the `reports/*.md` files, aggregate CSVs, and small samples explicitly called for at a checkpoint.
3. **Each step runs once, in order.** Every script reads the previous step's files from disk and is idempotent and resumable. Never re-run an upstream step unless its inputs changed. To narrow scope after Checkpoint 1, write `data/outputs/scope_calls.csv`; don't re-pull or re-match.
4. **Verify before you spend.** Phase 0 tests every endpoint shape (light metadata, content, transcript) on 3 real calls, so field-name problems surface before the bulk pulls, not after.
5. **Calibrate before production.** Prompt and schema problems are found and fixed on a fixed 60-call calibration set (Phase 3). Production coding (Phase 4) runs once, after the reliability gate is accepted. Codings are version-stamped, and a prompt change re-queues only stale codings.
6. **Cheapest execution path.** Production LLM coding uses the Message Batches API. The static system prompt and tool schema are marked for prompt caching. Use the sync path only for calibration and failure retries.
7. **No custom code mid-analysis unless needed.** `09_analyze.py` already implements every pre-registered test (T1–T9, RQ1–RQ8, the replication check, CRM agreement). Extend it only for a gap you name at a checkpoint.

## Phase 0: Setup and verification

No bulk pulls in this phase.

### Steps

0.1 **Environment**
- Create a venv and run `pip install -r requirements.txt`.
- Set `GONG_ENV_PATH`, or copy `.env.example` to `.env`.
- Confirm that these key **names** are present, by listing names only: `GONG_ACCESS_KEY`, `GONG_ACCESS_KEY_SECRET`, `HUBSPOT_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`.
- If the HubSpot token is missing, ask Will to create a read-only private app (scopes are listed in `.env.example`). The fallback is in Phase 1.
- If the Anthropic key is missing, plan for the agent-mode fallback.

0.2 **Probe** — run `python src/00_setup_check.py --probe`. It:
- confirms auth;
- fills Gong user IDs in `data/internal_roster.csv`;
- records internal email domains;
- writes `data/raw/probe_call_structure.json` (light tier), `probe_content_structure.json` (content tier) and `probe_transcript_structure.json`.

0.3 **Reconcile field names (only now)**
- Compare the probe files with `src/pull_spec.py` and with the fields read in `02_match_calls.py`, `04_pull_content.py` and `05_prepare_transcripts.py`. Fix any mismatch now.
- Report the CRM systems and object types seen in call context. Salesforce Opportunity objects on pre-migration calls are expected, and they are matched through the legacy Salesforce ID in Phase 1.

0.4 **Roster** — show Will unmatched roster names, plus any Gong users with sales-like titles that are missing from the roster, and confirm roles.

0.5 **ICP context**
- Read Findigs' ICP and buyer-persona documentation in Notion (the Revenue Operations wiki; it is the framework used by the `sdr-prospecting` and `target-account-ranker` skills).
- Write a summary of 400 words or fewer into `prompts/icp_persona_context.md`.
- The prompt stays at `call_v1.0`, because nothing has been coded yet.

### CHECKPOINT 0

Report:
- auth status for Gong, HubSpot and Anthropic;
- any field-name fixes you made;
- CRM context systems and object types;
- roster gaps.

Wait for approval.

## Phase 1: Assemble the full call sample (one bulk pass)

### Steps

1.1 **Run the two independent bulk pulls.** Either order works; they don't depend on each other.
- `python src/01_pull_calls.py` — lightweight metadata (parties and CRM context only) for **every** Gong call in the cohort window, paged by month. It is resumable and capped by the daily budget. Report calls per month.
- `python src/01b_build_associations.py` — builds `data/deal_associations.csv` for all 845 deals with HubSpot batch endpoints. Columns: legacy Salesforce Opportunity ID (auto-detected; confirm the property it picked), company IDs, domains and names, and contact emails and names. Report fill rates.
- *No HubSpot token?* Use HubSpot MCP batch tools only: `get_crm_objects` with many IDs, and association reads in bulk. If the MCP cannot return associations in bulk, stop and ask Will for a token. Do not fall back to per-deal calls.

1.2 **Match** — run `python src/02_match_calls.py`.
- It matches in tiers: M1 CRM deal/opportunity ID → M2 contact email → M3 company domain → M4 CRM account, all inside the deal window.
- Ambiguous matches are excluded and logged. Post-close calls are excluded.
- Spot-check 10 M3 matches using titles and dates from `call_deal_map.csv` only, and report their precision.

1.3 **Coverage and cost** — run `python src/03_coverage_report.py`.

### CHECKPOINT 1 (scope and cost decision)

Summarise `reports/01_coverage_report.md` in 15 lines or fewer:
- coverage for any call, any held meeting, and Discovery-or-later meetings;
- the won-deal control size;
- which dimensions have biased coverage;
- strata that are unrepresented or weight-capped;
- for each hypothesis T1–T9, whether it is testable at reportable, directional, or not-testable n;
- the **volume and cost forecast** (in-scope meetings, Gong requests, transcript tokens).

If won-deal coverage is under 20, propose a separate, clearly labelled sensitivity control: New Logo wins from the prior 12 months.

If Will narrows scope, write `data/outputs/scope_calls.csv` and do not re-run Phase 1. Wait for approval.

## Phase 2: Fetch and prepare content (one pass)

### Steps

2.1 `python src/04_pull_content.py --yes` — fetches Gong content **and** transcripts together for every in-scope meeting, 100 call IDs per request. Unavailable items are recorded as `_empty`, never dropped.

2.2 `python src/05_prepare_transcripts.py` — redacts transcripts and replaces speakers with role tokens. It uses the deal's company, contact and deal names from the associations file, and writes `data/outputs/redaction_leak_scan.csv`.
- If the scan shows residual emails or phones, or a high possible-name count, tighten the rules and re-run **only** this step. It is local, with no API cost.
- Don't open transcripts to check by eye. If the scan is ambiguous, view at most 3 flagged lines.

## Phase 3: Calibrate the coding (before any production coding)

### Steps

3.1 `python src/06_code_calls.py --calibration 60 --yes` — codes a fixed, stratified 60-call set (one call per deal; spread across outcome × stage × segment) with **both** the primary model and the second model, using the sync path. The coder stays blind to outcome.

3.2 `python src/08_reliability_check.py --packet` — builds the human review packet (20 calibration calls × 17 fields).
- Will fills `reviewer_agrees (Y/N)`. Offer to walk him through each call, showing the coded value and the redacted transcript excerpt for that field only.

3.3 `python src/08_reliability_check.py --score` — calculates κ and agreement per field, plus the human agreement rate.

### CHECKPOINT 2 (calibration gate)

Present together:
- κ, the resulting gate, and the human agreement rate for each field;
- fields that were often "unclear";
- missing enum values;
- prompt ambiguities;
- 5 calibration calls shown with their coded fields beside paraphrased justification.

If Will approves changes:
1. Edit the prompt and/or schema.
2. Bump `prompt_version`.
3. Re-run 3.1 and 3.3 (only stale calibration codings are re-done).

Iterate on these 60 calls only. Production starts when Will accepts the gate. Fields gated "excluded" are either fixed here or dropped from the analysis plan in writing.

## Phase 4: Production coding (one pass, Batch API)

### Steps

4.1 Run, in order:
- `python src/06_code_calls.py --dry-run` — report the call count and token estimate.
- `python src/06_code_calls.py --all --batch --yes`
- `python src/06_code_calls.py --collect` — this retries failures through the sync path. Calibration calls already coded under the current version are skipped.

4.2 Only after 4.1 has fully collected (synthesis needs every call for a deal):
- `python src/07_synthesize_deals.py --batch --yes`
- `python src/07_synthesize_deals.py --collect`

4.3 **Integrity check.** Report counts of prepared vs coded calls, `_skipped` empties, failures, and synthesised deals. Continue straight to Phase 5 unless failures exceed 2%; in that case, report and wait.

## Phase 5: Analysis and findings

### Steps

5.1 `python src/09_analyze.py` — one row per deal. It covers:
- won-vs-lost comparisons in frames F_all_held, F_opportunity, F_negotiation and F_mid_market_opp;
- RQ3 Discovery behaviour, comparing deals that advanced with deals that died;
- T3 Bad Timing subset;
- T9 silence and gaps;
- RQ7 CRM-vs-transcript agreement;
- the Q3 2026 comparison;
- split-half replication, personas, prospect questions × answer quality, objections, friction, competitors and deal breakers.

All of it applies Wilson intervals, n flags, BH-FDR q-values, IPW, reliability gates and concentration checks.

5.2 Fill `reports/04_findings_register.csv` from the template. For every F and H row, record:
- verdict (Reinforces / Contradicts / Supplements / Not testable);
- evidence references (tab, frame, feature);
- confidence;
- a one-sentence rationale;
- the proposed paper edit.

Exploratory findings are promoted only if they meet the discriminating rule **and** `replication_halves` shows `replicates_both_halves = True`.

5.3 Write `reports/05_transcript_findings.md`:
- bottom line;
- findings by RQ1–RQ8, each with number, n, CI, the won-vs-lost contrast, verdict label, and quotes chosen by the quote rule from `data/outputs/quote_bank.csv` (filter by category in code; don't read the whole file into context);
- new insights;
- what transcripts could not tell us;
- implications for each of the paper's priorities;
- an enablement backlog (questions to add or retire, prospect questions we answer poorly);
- a collapsible Sources & Methodology section.

### CHECKPOINT 3

Walk Will through contradictions first, then reinforcements, then new insights. Wait for approval.

## Phase 6: Paper polish

### Steps

6.1 Write `reports/06_paper_revision_plan.md`, section by section: what changes, the evidence behind it, and any changes to goals, KPIs or priorities. Keep the Amazon-narrative discipline:
- body of 6 pages or fewer, written as narrative prose;
- specific numbers;
- exhibits in the appendix;
- an FAQ.

Likely additions: a "voice of the prospect" paragraph in State of the Business; transcript exhibits (momentum inflection by tier, answer quality by question category, deal-breaker classification); FAQ entries on coverage limits.

6.2 After approval, rebuild the paper from `docs/reference/paper_source/`:
- Repoint `charts.py` to `data/cohort_deals.csv` and `data/outputs/deal_features.csv`.
- Edit `content.py`.
- Run `python content.py && node build.js` (exhibit PNGs are in `docs/reference/exhibits/`).
- Render the PDF and check every page visually.
- Save as `Why_and_Where_We_Lose_New_Logo_Deals_v2.docx` / `.pdf`.

### CHECKPOINT 4 (final)

Deliverables:
- `reports/04_findings_register.csv`
- `reports/05_transcript_findings.md`
- `reports/06_paper_revision_plan.md`
- the v2 paper (`.docx` and `.pdf`)
- a proposed retention date for `data/raw/`

Nothing is "done" until these files exist.

## Agent-mode fallback (no `ANTHROPIC_API_KEY`)

If there is no API key, you can code the calls yourself.
- Do calibration first (Phase 3, the same 60 calls) before coding the rest. Use the same prompt and schema, in batches of 10 prepared transcripts.
- Write one JSON file per call into `data/coded/calls/`, matching the format `06_code_calls.py` writes, with `prompt_version` and `"model": "claude-code-agent"`.
- Validate each file with `jsonschema` against `schema/call_coding_schema.json`.
- Stay blind: never open `cohort_deals.csv` outcome or reason columns while coding.
- **Reliability.** Use subagents for the second coding pass, with a fresh context and the same prompt. Will's human review becomes mandatory.
- **Effort.** Estimate and report the effort before starting, because this route is much slower.

## Known pitfalls

- **Token discipline.** The biggest avoidable cost is Claude Code reading transcripts or per-call JSON into its own context. Let the scripts aggregate.
- **Batch results.** Results can take up to 24 hours. `--collect` is safe to re-run and resumes polling. Don't start `07` until `06 --collect` reports zero outstanding batches.

- **Cursors.** Gong cursors expire quickly. Don't pause mid-pagination. The pull scripts are resumable by month and by call ID.
- **Account-wide rate limits.** Gong's 3 requests per second and 10,000 per day are shared with other Gong integrations. Keep `GONG_MAX_RPS` at or below 2.5.
- **Time zones.** Gong timestamps are UTC, while HubSpot dates in the cohort are portal-local dates. The ±14 / +7 day window absorbs this. Don't tighten it without checking.
- **Dialer calls.** Short SDR dialer calls are not meetings. Keep `MIN_MEETING_SECONDS` at 120 or above, and report how many matched calls fell under the threshold.
- **Untagged calls.** Gong's own `brief`, `topics`, and `trackers` are pulled with the metadata. Use them as a cross-check, not as the primary coding.
- **Post-close calls.** A won deal's implementation kickoff calls fall after close. They are excluded by the window and are not wins evidence.
- **Shared windows.** Prospects with several deals (for example, a lost deal followed by a later win) can share calls. That is exactly why the ambiguous-match rule exists. Report how many such cases there are.
- **Question limits.** If the pilot shows the 25-question limit on `findigs_questions` truncating long Discovery calls, raise the limit and bump the version.
