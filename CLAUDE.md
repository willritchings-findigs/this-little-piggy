## GTM executive dashboard (`gtm-dashboard/`)

Self-contained HTML dashboard for revenue leadership, rebuilt weekly from HubSpot by the `gtm-dashboard-refresh` skill (`.claude/skills/gtm-dashboard-refresh/SKILL.md` at the repo root). Refreshes build and commit on `config.distribution.git_branch` only.

- How every number is calculated: Notion → Revenue Operations wiki → Reporting & Analytics → **Data Definitions**. `gtm-dashboard/config.json` mirrors it and the skill refuses to run if they disagree. Change definitions there, not in code or in this file.
- Build is deterministic: `data/*.json` → `python build.py` → `output/`. `build.py` exits 2 if pulled records don't reconcile to the reporting-API controls in `data/controls.json`, and writes nothing. Don't edit `controls.json` to make it pass. Single-record gaps (a blank source, an unresolved owner) don't stop the build; they're bucketed and flagged. `build.py --diagnostic` answers questions without touching `data/kpi_history.json` or `runs/runs.jsonl`.
- Read-only against HubSpot. Never edit a deal, company, or Notion record from this repo.
- Manual runbook and decisions log: `gtm-dashboard/README.md`. Data file shapes: `gtm-dashboard/schema.md`.

