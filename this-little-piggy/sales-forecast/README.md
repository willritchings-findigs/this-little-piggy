# Sales forecast (weekly AE forecast tool)

Google Apps Script web app for the Friday AE forecast and the Monday Revenue Leadership review.
- **Forecast submission:** each AE submits incremental closed-won USD (Commit ≤ Gut ≤ Best Case) through Dec 31, every Friday before 12:00 ET.
- **Forecast builder:** tag open deals to build those numbers.
- **Forecast trend:** week-over-week movement, with a deal-level drill-down.

Every submission is an immutable JSON snapshot in Drive, plus a row in a rollup Sheet. The app only reads HubSpot.

- Architecture and decisions log: `docs/PHASE0_PROPOSAL.md`
- QA test list: `docs/QA.md`

## Contents
1. [Who can do what](#who-can-do-what)
2. [One-time deployment](#one-time-deployment)
3. [Secrets](#secrets)
4. [Go-live checklist](#go-live-checklist)
5. [Shipping a change](#shipping-a-change)
6. [Weekly operations](#weekly-operations)
7. [Roster maintenance](#roster-maintenance)
8. [Year rollover](#year-rollover)
9. [Test mode and synthetic data](#test-mode-and-synthetic-data)
10. [Troubleshooting](#troubleshooting)
11. [Local development](#local-development)

## Who can do what
| Role | Who (config/roster.json) | Can |
|---|---|---|
| `ae` | Spencer Wuthrich, Ian McLaughlin, Ben de Winter, Matt Lynch | Submit and tag for themselves. See every row, builder, and trend (full transparency, decision P3-2) |
| `ae_leader` + admin | Phil Aroian | Same as `ae`, plus everything an admin can do (`"admin": true` on his AE entry) |
| `leadership` | Alexander Schaper, Asaf Raz | See everything. No edits |
| `admin` | Will Ritchings, Brian Korchin | See everything, edit **any AE's builder tags**, submit on behalf of any AE, and run the editor functions below |

When someone other than the AE sets a tag, the AE's builder says so ("3 tags were last set by Will Ritchings…") and marks each deal "set by …". The snapshot records who set each tag (`tag_updated_by`, schema 1.1). Tags are shared: whoever changes a deal's tag last wins, and it goes into the AE's next submission.

Anyone with a Findigs Google account who is not on the roster gets "Access denied".

## One-time deployment
Already done for 2026. These steps are for rebuilding from scratch or handing the tool to a new owner.

**Prerequisites:** Node.js LTS (`node -v` shows 20 or later) and a Google account in the findigs.com Workspace. All commands below are Windows PowerShell and assume the repo is cloned at `C:\Users\<you>\this-little-piggy`.

1. **HubSpot private app** (HubSpot super admin): go to Settings → Integrations → Private apps → **Create**.
   - Name: **Findigs Sales Forecast (read-only)**.
   - Scopes: `crm.objects.deals.read`, `crm.objects.owners.read`, `crm.schemas.deals.read`. **No write scopes.**
   - Copy the access token. It goes into Script Properties in step 4 and nowhere else.
2. **Install clasp and log in**
   ```powershell
   npm install -g @google/clasp
   clasp login
   ```
   Also turn on the Apps Script API at https://script.google.com/home/usersettings.
3. **Create the project and push the code**
   ```powershell
   cd "C:\Users\<you>\this-little-piggy\this-little-piggy\sales-forecast"
   npm test
   clasp create --type standalone --title "Sales Forecast" --rootDir appsscript
   git checkout appsscript/appsscript.json
   clasp push
   ```
   - `clasp create` overwrites the manifest, so `git checkout` restores the correct one.
   - `clasp create` writes `.clasp.json` in `sales-forecast/`. Always run `clasp push` from that folder, not from `appsscript/`.
   - Answer **y** if `clasp push` asks to overwrite the manifest.
4. **Script properties** (Apps Script editor → Project Settings → Script properties): add `HUBSPOT_TOKEN` = the token from step 1.
5. **First run:** in the editor, select `debugSampleAe` and click **Run**. Approve the permissions (Drive, Sheets, external requests, triggers, your email).
   - The log should show `tieOut.ok: true` and Ben de Winter's figures.
   - A **Sales Forecast Rollup 2026** Sheet and a `_system` folder appear in the 2026 Drive folder.
6. **Refresh trigger:** run `installTriggers` once. It refreshes HubSpot data every 30 minutes. Running it again replaces the trigger, never duplicates it.
7. **Web app:** Deploy → **New deployment** → type **Web app**.
   - Description: `v1`
   - Execute as: **Me**
   - Who has access: **Anyone within Findigs**
   - Click **Deploy** and copy the URL ending in `/exec`. That is the link to share.

The script runs as its owner (Will), so AEs never need access to the Drive folder, the Sheet, or HubSpot. The owner's Google account must keep **Content manager** (or higher) access on the Shared Drive folders.

## Secrets
- The only secret is the HubSpot private-app token, stored in the Script Property `HUBSPOT_TOKEN`. It is never committed, logged, or sent to the browser.
- **To rotate:** in HubSpot, private app → Auth → **Rotate**. Paste the new token into the Script Property. No code change or redeploy is needed.
- The token is read-only by scope. Independently, `HubSpot.gs` refuses any request that is not a GET or a POST to a `/search` endpoint.
- If the token is ever exposed: rotate it immediately, then check HubSpot's private app logs.

## Go-live checklist
The project is currently in **test mode** (see below). To go live:
1. `git pull`, `npm test`, `clasp push` (see [Shipping a change](#shipping-a-change)).
2. Project Settings → Script properties → **delete** `FORECAST_TEST_FOLDER_ID`. The TEST MODE banner disappears. Test and synthetic files stay in `_test` and are never read again.
3. Confirm `installTriggers` has been run: Triggers (clock icon) lists `refreshDataTrigger`, every 30 minutes.
4. Create the production deployment (step 7 above) and share the `/exec` URL with the roster.
5. Make one real submission, then delete nothing. It becomes that AE's official number, and they can resubmit before the cutoff.
6. After the first Friday, run `verifySnapshots` and work through the live checks at the end of `docs/QA.md`.

## Shipping a change
Code and config changes both go through the same steps:
```powershell
cd "C:\Users\<you>\this-little-piggy"
git pull
cd "C:\Users\<you>\this-little-piggy\this-little-piggy\sales-forecast"
npm test
clasp push
```
- **The test link** (Deploy → Test deployments, URL ending in `/dev`) always runs the latest pushed code.
- **The production `/exec` link does not update on push.** Go to Deploy → **Manage deployments** → pencil icon → Version: **New version** → **Deploy**. The URL stays the same.
- `npm test` fails if a generated file is stale or the config breaks a rule, for example Renewal in scope, a forbidden field such as `hs_acv`, a duplicate roster entry, or a missing Drive folder for the roster year. Never edit `Generated_*` or `Client_Core.html`, `Client_Config.html`, `Client_ChartLoader.html`, or `Vendor_ChartJs.html` by hand. Run `npm run build`.

Settings that live in config:

| Setting | File |
|---|---|
| Cutoff day and time, late rule | `config/forecast.json` → `cutoff` |
| WoW highlight threshold (0.10) | `config/forecast.json` → `section3.delta_threshold_pct` |
| Series colors (identical across all three sections) | `config/forecast.json` → `series_colors` |
| Forecast definitions shown in the app | `config/forecast.json` → `definitions` |
| Pipelines, stage IDs, fields, tie-out tolerance | `../gtm-dashboard/config.json` (shared with the GTM dashboard; changing it changes both tools) |

## Weekly operations
- **Friday before 12:00 ET:** each AE submits. They can resubmit until the cutoff; the last one before 12:00:00 ET is official. At exactly 12:00:00 and later, a submission counts toward **next** Friday.
- **AE is out:** an admin opens Forecast submission, picks the AE under **Submit on behalf of**, and submits. The snapshot records the admin as submitter.
- **Forecast call with screen share:** an admin opens Forecast builder, picks the AE, and tags deals while the AE walks through them. Then, in Forecast submission, the admin picks the same AE and submits their numbers, or the AE submits them. The snapshot freezes the tags with who set each one.
- **Monday review:** open Forecast trend. The change table defaults to the most recent closed week. Click any AE point, or **Deal movement**, for the builder-tag drill-down. A red **Does not reconcile** means the submitted change is larger or smaller than the tag movement explains. Ask the AE; it is never adjusted.
- **Missed week:** it shows as a gap marked "Not submitted". It cannot be back-filled. A late submission counts toward the next week, by design (decision Q1).
- **Need fresher HubSpot data than the 30-minute refresh:** run `refreshDataTrigger` from the editor. Each submission already re-pulls that AE's figures.
- **Monthly, or after anyone touches the Drive folder:** run `verifySnapshots` from the editor. `"ok": true` means every snapshot still matches the SHA-256 recorded when it was written.

Never edit or delete files in the year folders or rows in the rollup Sheet. The only in-place edit the app makes is flipping `is_official` when an AE resubmits.

## Roster maintenance
The roster is `config/roster.json`. The app re-checks every owner against HubSpot on each refresh and flags one that becomes inactive or loses their user seat.

**Add an AE**
1. Find their HubSpot owner ID: HubSpot → Settings → Users & Teams → click the user; the ID is in the URL. Or ask the GTM dashboard maintainer.
2. Add an entry to `aes`:
   ```json
   { "name": "Jane Doe", "slug": "jane-doe", "email": "jane.doe@findigs.com", "hubspot_owner_id": "123456789", "role": "ae" }
   ```
   `slug` is lowercase with hyphens and is used in snapshot file names. Never change it once the AE has submitted.
3. If they were listed under `non_roster_owners`, remove them from there.
4. Bump `"version"` to today's date, then run the [Shipping a change](#shipping-a-change) steps, including the new deployment version.

**Remove or replace an AE**
- Snapshots and rollup rows are permanent and stay in Drive.
- Charts and the change table only show AEs on the roster. **Keep a departed AE on the roster until the end of the fiscal year** so the trend and team totals stay complete.
- Once they leave HubSpot, the app flags their owner as inactive or without a seat. That is expected.
- To stop them from submitting sooner, move them to `non_roster_owners` with a reason. Their trend history then drops out of Section 3 for the rest of the year.

**Leadership and admins:** edit `leadership` or `admins` and ship the change. An email may appear in only one list. To make an AE an admin as well, add `"admin": true` to their AE entry (as with Phil) rather than listing them twice.

**Non-roster owners:** `non_roster_owners` lists people who hold in-scope deals but do not forecast (currently Reese Ryan, Clay Stapleford, Hayden Ashwill). They appear in a read-only reconciliation row, so Section 1 totals tie to the company total. Add a `reason` so the Sources & methodology panel explains them.

## Year rollover
Forecast weeks belong to the year of their Friday.
- Submissions after the **last Friday cutoff of the year** (Dec 25, 2026, 12:00 ET) count toward the week of Jan 1, 2027, which is FY2027.
- They are **blocked** until FY2027 has a Drive folder.
- On **Jan 1**, the data refresh and the builder also move to FY2027 and **fail** without the folder.
- From Dec 1, admins see a yellow **Year rollover** banner, and `npm test` prints a warning, until the folder is configured.

**Checklist (do it in early December):**
1. In the Shared Drive, next to the 2026 folder, create **2027**. Copy its ID from the URL (the part after `/folders/`).
2. In `config/forecast.json`, add it under `drive.folders_by_fiscal_year`:
   ```json
   "folders_by_fiscal_year": { "2026": "1WGzeVVLMlfTHpU9S5GKVB45EDRx84I_P", "2027": "<new folder id>" }
   ```
3. Review the roster for next year. On Jan 1, change `"fiscal_year"` in `config/roster.json` to `2027`.
4. Ship the change, including the new deployment version.
5. After the first FY2027 submission, confirm **Sales Forecast Rollup 2027** appeared in the 2027 folder.

What happens at the turn of the year:
- The first FY2027 submission (the week of Jan 1) records Closed Won YTD as $0, with a warning, and the period runs through Dec 31, 2027.
- **Forecast builder tags start fresh on Jan 1.** They live in each year's rollup. AEs re-tag for the new year.
- Forecast trend defaults to the year of the last closed week, so the first days of January still show 2026. A **Year** selector appears once two years are configured.
- Weighted pipeline, stage IDs, and the tie-out are unaffected.

## Test mode and synthetic data
With the Script Property `FORECAST_TEST_FOLDER_ID` = `17CBtW0XTcMq-GO3OsXlbRArf9olSHnIg` set:
- Every write (snapshots, rollup, builder tags, cache, build log) goes to **Sales Forecasts → _test → FY<year>**.
- The app shows a TEST MODE banner.
- Production folders are never touched. Delete the property to leave test mode; no redeploy is needed.

`seedSyntheticSnapshots` (run from the editor) seeds four closed weeks of synthetic history for Section 3.
- It refuses to run outside test mode, refuses to seed twice, and skips any AE/week that already has real test rows.
- File names start with `forecast_synthetic_`, `submission_id` starts with `synthetic-`, and the snapshot has `"synthetic": true`.
- Built-in scenarios: Spencer misses a week (gap), Ian resubmits (overlay), Ben saves no tags one week (no inference), and Matt's last week does not reconcile (red flag).

## Troubleshooting
| Symptom | Cause and fix |
|---|---|
| Red **Tie-out mismatch** badge or banner | The Search API and the independent Objects list disagree on Closed Won YTD or Gross Open by more than $0.01. The `build_log` tab in the rollup lists the deal IDs. Usually a deal was edited mid-pull; wait for the next 30-minute refresh, or run `refreshDataTrigger` from the editor to refresh now. If it persists, compare with the HubSpot report and the `verification/` scripts |
| "Won stage drift" / "Lost stage drift" error | Someone added or changed a stage in HubSpot. Update `../gtm-dashboard/config.json` `terminal_stages` (shared with the GTM dashboard), then ship the change. The app stops rather than misclassify deals |
| "HUBSPOT_TOKEN is not set" or HTTP 401 | Token missing, rotated, or the private app was deleted. See [Secrets](#secrets) |
| "No Drive folder configured for FY…" | See [Year rollover](#year-rollover) |
| "Another submission is being saved…" | Two writes collided on the script lock; nothing was saved. Submit again after a few seconds |
| "Access denied" | The Google account isn't on the roster, or the user is signed into a personal account. Use the findigs.com account |
| The `/exec` link shows old behavior | A new deployment version wasn't created. See [Shipping a change](#shipping-a-change) |
| `npm test` shows `STALE` on Windows | Run `npm run build`, then `npm test`. The build normalizes line endings |
| `verifySnapshots` lists a problem | A snapshot file was edited, moved, or deleted in Drive. Restore it from Drive trash or version history; never recreate it by hand. The drill-down also flags it |
| Charts don't render | The chart library couldn't load from the CDN or the bundled copy. The "View as table" data and the change table still work. Sources & methodology → Build shows which source loaded |

## Local development
```powershell
npm test                                   # build --check + 107 tests (browser tests skip if Playwright isn't installed)
npm run preview                            # http://127.0.0.1:8787/?as=ben.dewinter@findigs.com  (try ?as=brian.korchin@findigs.com)
node scripts/preview.mjs 8787 --synthetic  # test mode with four weeks of synthetic history
npm run verify:phase1                      # re-runs the 2026-09-25 tie-out from verification/
```
The preview runs the real `.gs` and UI code against a fake HubSpot serving the 2026-09-25 live pulls, with in-memory Drive and Sheets. It never calls Google or HubSpot.

```
config/roster.json, config/forecast.json   hand-edited sources
core/forecast_core.js                      all business logic (Node-tested; copied into Apps Script and the browser)
appsscript/                                clasp project root
  HubSpot.gs Data.gs Storage.gs BuilderState.gs Snapshots.gs Trend.gs Synthetic.gs Main.gs   server
  Index.html Styles.html Client_App/Builder/Submission/Trend/Methodology.html              UI
  Generated_*.gs, Client_Core/Config/ChartLoader.html, Vendor_ChartJs.html                 GENERATED
vendor/chart.umd.js                        Chart.js 4.4.4 (MIT), byte-identical to the jsDelivr file
scripts/                                   build.mjs, preview.mjs, verify_phase1.mjs
tests/                                     node --test: core, Apps Script simulation, API, QA, Chromium UI
verification/                              live pulls, tie-outs, trial logs, screenshots
```
