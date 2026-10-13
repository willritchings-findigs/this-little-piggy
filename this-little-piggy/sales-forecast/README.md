# Sales forecast (weekly AE forecast tool)

Google Apps Script web app for the Friday AE forecast and the Monday Revenue Leadership review.
- **Forecast submission:** each AE submits incremental closed-won USD (Commit ≤ Gut ≤ Best Case) through Dec 31, every Friday before 5:00 PM ET.
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
7. [Admin panel](#admin-panel)
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
| `admin` | Will Ritchings, Brian Korchin | See everything, edit **any AE's builder tags**, submit on behalf of any AE, and use the **Admin** tab (users, health, year rollover) |

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
- **Friday before 5:00 PM ET:** each AE submits, and the 2:00–3:00 PM ET Weekly Pipeline / Forecast call happens before the cutoff, so changes made on the call count for that week (decision P5-5). AEs can resubmit until the cutoff; the last one before 4:59:59 PM ET is official. At exactly 5:00:00 PM and later, a submission counts toward **next** Friday.
- **AE is out:** an admin opens Forecast submission, picks the AE under **Submit on behalf of**, and submits. The snapshot records the admin as submitter.
- **Forecast call with screen share:** an admin opens Forecast builder, picks the AE, and tags deals while the AE walks through them. Then, in Forecast submission, the admin picks the same AE and submits their numbers, or the AE submits them. The snapshot freezes the tags with who set each one.
- **Monday review:** open Forecast trend. The change table defaults to the most recent closed week. Click any AE point, or **Deal movement**, for the builder-tag drill-down. A red **Does not reconcile** means the submitted change is larger or smaller than the tag movement explains. Ask the AE; it is never adjusted.
- **Missed week:** it shows as a gap marked "Not submitted". It cannot be back-filled. A late submission counts toward the next week, by design (decision Q1).
- **Need fresher HubSpot data than the 30-minute refresh:** Admin → Data health → **Refresh HubSpot data now** (or run `refreshDataTrigger` from the editor). Each submission already re-pulls that AE's figures.
- **Monthly, or after anyone touches the Drive folder:** Admin → Data health → **Run snapshot integrity check** (or run `verifySnapshots` from the editor). `"ok": true` means every snapshot still matches the SHA-256 recorded when it was written.

Never edit or delete files in the year folders or rows in the rollup Sheet. The only in-place edit the app makes is flipping `is_official` when an AE resubmits.

## Admin panel
Admins (Will, Brian, Phil) see an **Admin** tab. Everything in it takes effect immediately, with no code push or redeploy, and every change is written to the rollup's `admin_log` tab (who, what, when, before/after). Every action asks for a confirmation first.

| Section | What it does |
|---|---|
| **Users** | **Invite user**: email, name, access level (AE, AE and leadership, Leadership, Admin), "also an admin" for AEs, and for AEs the HubSpot owner, picked from a live HubSpot list. Owners already assigned to an AE can't be picked. Optionally emails the invite: app link, what they can do, the Notion guide, and the Friday deadline. **Change access**, **Deactivate** / **Reactivate**, **Resend invite**. |
| **This week's submissions** | Who has and hasn't submitted, with a **Submit on behalf** shortcut. |
| **Data health** | Last pull, tie-out, trigger status, app link, recent data pulls. Buttons: **Refresh HubSpot data now**, **Install refresh trigger** (if missing), **Run snapshot integrity check**. |
| **Year rollover** | The Drive folder for each fiscal year; set the current or next year's folder if it's missing. |
| **Other owners** | Add, edit, or remove people who hold deals but don't forecast, with the reason shown in the app. |
| **Admin activity log** | The last 50 admin changes this year. |
| **Settings** | Read-only: cutoff, highlight threshold, snapshot format, guide link, test mode. These change only through code, so a mid-week change can't move submissions between weeks. |

**Rules the panel enforces** (in `ForecastCore.applyRosterChange`):
- findigs.com emails only, and one active entry per person.
- An AE needs a HubSpot owner that exists and isn't another AE's.
- AE slugs never change, because they name snapshot files. Re-inviting a name that's taken gets a suffix, such as `jane-doe-2`.
- There's always at least one active admin, and no admin can demote or deactivate themselves.

**Deactivating** removes access immediately.
- For an AE, their row leaves Forecast submission and their deals move to **Other owners**, so totals still tie to HubSpot.
- Their past weeks stay in Forecast trend, labeled "(inactive)". Snapshots are never deleted.
- Reactivating restores everything.
- A leadership or admin entry is removed on deactivation; invite them again to restore it.

**Moving an AE to Leadership or Admin** keeps their inactive AE record for history. Moving them back reuses the same slug.

### Where the roster lives
- Until the first change in the panel, the app uses `config/roster.json`.
- The first panel change copies it into the Script Property `ROSTER_JSON`, and from then on **the panel is the source of truth**. Editing `config/roster.json` afterwards has no effect on the running app; it only seeds a brand-new deployment.
- Don't edit or delete `ROSTER_JSON` by hand. Deleting it would reset the roster to `config/roster.json`.
- Years added under Year rollover are stored in `FY_FOLDERS_JSON`. Folders in `config/forecast.json` win for the same year.

**Invite emails** are sent from the script owner's Gmail (Will) with **Reply-To** set to the admin who clicked Invite. They're never sent in test mode.
- The first `clasp push` with the admin panel adds one Google permission: **send email as you**. After pushing, run any function from the editor, for example `installTriggers`, and approve it, then create the new deployment version.
- Gmail limits apply: 1,500 emails a day on Workspace, far above what this app sends.

## Year rollover
Forecast weeks belong to the year of their Friday.
- Submissions after the **last Friday cutoff of the year** (Dec 25, 2026, 5:00 PM ET) count toward the week of Jan 1, 2027, which is FY2027.
- They are **blocked** until FY2027 has a Drive folder.
- On **Jan 1**, the data refresh and the builder also move to FY2027 and **fail** without the folder.
- From Dec 1, admins see a yellow **Year rollover** banner, and `npm test` prints a warning, until the folder is configured.

**Checklist (do it in early December):**
1. In the Shared Drive, next to the 2026 folder, create **2027**. The script owner (Will) needs Content manager access to it, which a new folder in the same shared drive inherits.
2. In the app: **Admin → Year rollover**, choose FY2027, paste the folder link, **Set folder**, then **Confirm**. The app checks it can open the folder. There's no code change or redeploy.
3. Review the roster for next year in **Admin → Users**.
4. After the first FY2027 submission, confirm **Sales Forecast Rollup 2027** appeared in the 2027 folder.

To make the folder permanent in code later, add it to `config/forecast.json` → `drive.folders_by_fiscal_year` and ship the change. The config entry then takes precedence and the panel shows "config/forecast.json".

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
| "Access denied" | The Google account isn't on the roster, is deactivated, or the user is signed into a personal account. Check **Admin → Users**; they must use their findigs.com account |
| An AE's row disappeared from Forecast submission | They were deactivated or moved out of the AE role. See **Admin → Admin activity log**; reactivate from **Admin → Users** |
| Invite email didn't arrive | Test mode doesn't send email. Otherwise check spam, then **Resend invite**. The script owner must have approved the "send email" permission (see [Admin panel](#admin-panel)) |
| The `/exec` link shows old behavior | A new deployment version wasn't created. See [Shipping a change](#shipping-a-change) |
| `npm test` shows `STALE` on Windows | Run `npm run build`, then `npm test`. The build normalizes line endings |
| `verifySnapshots` lists a problem | A snapshot file was edited, moved, or deleted in Drive. Restore it from Drive trash or version history; never recreate it by hand. The drill-down also flags it |
| Charts don't render | The chart library couldn't load from the CDN or the bundled copy. The "View as table" data and the change table still work. Sources & methodology → Build shows which source loaded |

## Local development
```powershell
npm test                                   # build --check + 127 tests (browser tests skip if Playwright isn't installed)
npm run preview                            # http://127.0.0.1:8787/?as=ben.dewinter@findigs.com  (try ?as=brian.korchin@findigs.com)
node scripts/preview.mjs 8787 --synthetic  # test mode with four weeks of synthetic history
npm run verify:phase1                      # re-runs the 2026-09-25 tie-out from verification/
```
The preview runs the real `.gs` and UI code against a fake HubSpot serving the 2026-09-25 live pulls, with in-memory Drive and Sheets. It never calls Google or HubSpot.

```
config/roster.json, config/forecast.json   hand-edited sources
core/forecast_core.js                      all business logic (Node-tested; copied into Apps Script and the browser)
appsscript/                                clasp project root
  Admin.gs HubSpot.gs Data.gs Storage.gs BuilderState.gs Snapshots.gs Trend.gs Synthetic.gs Main.gs   server
  Index.html Styles.html Client_App/Builder/Submission/Trend/Methodology/Admin.html                 UI
  Generated_*.gs, Client_Core/Config/ChartLoader.html, Vendor_ChartJs.html                 GENERATED
vendor/chart.umd.js                        Chart.js 4.4.4 (MIT), byte-identical to the jsDelivr file
scripts/                                   build.mjs, preview.mjs, verify_phase1.mjs
tests/                                     node --test: core, Apps Script simulation, API, QA, Chromium UI
verification/                              live pulls, tie-outs, trial logs, screenshots
```
