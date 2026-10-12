# `publish.py` — real fix for the Drive upload size limitation

**Status (2026-10-12): built.** `publish.py` implements this spec and `test_publish.py` tests it offline. What's still open is provisioning, items 1–3 under "Open items" below. Item 4 is answered: outbound HTTPS to `oauth2.googleapis.com` and `www.googleapis.com` works from the cloud environment (verified 2026-10-12). The text below is the original design, kept as the rationale.

## Why this exists

The Drive connector's `create_file` tool requires the model to generate the file's
entire content as a single tool-call argument. The dashboard HTML is 664KB (as of
the SDR section) and will only grow. That's a hard ceiling on what a model-generated
tool call can carry — no folder path, permission, or retry logic changes it (confirmed
2026-09-28, re-confirmed 2026-09-29). The only real fix is to upload the file the way
any script would: stream it to Drive's own upload API, outside the model-tool-call
mechanism entirely.

This was the spec for that fix; `publish.py` now implements it.

## What `publish.py` would do

A small script, run by the skill in place of the `create_file` tool call:

```
python publish.py output/findigs_gtm_executive_dashboard_<as_of>.html
```

It authenticates as a Google service account and performs a **resumable upload**
(Drive API v3 `files.create` with `uploadType=resumable`): open a session, PUT the
file in chunks, get back the file's `id` and `webViewLink`. It prints the link to
stdout; the skill captures that and uses it to fill `<DRIVE_LINK>` in
`slack_post.txt`. No content passes through a model tool call — this is a normal
Python process making normal HTTP requests, so the 664KB (or 6.64MB) file size is a
non-event.

## Required OAuth scope

`https://www.googleapis.com/auth/drive.file` — least-privilege. A service account
with this scope can create and manage files it creates itself inside a folder it has
been granted **Content Manager** (or higher) access to; it does not need visibility
into the rest of the Shared Drive. Do **not** grant the broad `.../auth/drive` scope
unless `drive.file` proves insufficient in testing against the actual Shared Drive
folder (unlikely — this is a standard "app writes into a folder it's a member of"
pattern).

## Where the credential would live

Not created, stored, or requested here, per the ground rules — this section only
specs *where it would go*, for whoever provisions it:

- A GCP service account is created (outside this session, by whoever administers
  the Findigs Google Workspace / GCP project), with the scope above.
- Its JSON key is added to the **Claude Code Routine's environment** as a secret —
  not committed to this repo, not written to any file under `gtm-dashboard/`. The
  Routine environment's secret-injection mechanism (however this account's Routines
  expose secrets to a running skill — e.g. an environment variable pointing at a
  mounted file path, or the secret's raw content in an env var) supplies it at
  run time.
- `publish.py` would read the credential from that environment variable (proposed
  name: `GTM_DASHBOARD_SA_KEY` — either the JSON key content directly, or a path to
  it, depending on how this account's Routines actually expose secrets, which I
  haven't verified). It never touches disk inside the repo.
- Add the env var name (not its value) to `README.md → Prerequisites` once this is
  built, so a manual run knows it needs to be set.

## Folder / Shared Drive permission needed

The destination (`config.distribution.gdrive_folder_id`,
`1uxooqagOt5pmyOKYjrH3ZLf9wjhNRuoX`, "GTM Leadership Dashboard") is inside a genuine
**Shared Drive** (confirmed 2026-09-29 via its parent chain — the root is a Shared
Drive, not My Drive). Shared Drive permissions do **not** inherit from sharing a
single subfolder the way My Drive does: the service account's email needs to be
added as a **member of the Shared Drive itself** (Content Manager role is enough;
Manager is not needed), not just granted access to the one subfolder. This is a
manual step for whoever administers that Shared Drive — I can't grant it myself.

## What the skill's step 6.1 becomes, once this exists

Today: the skill calls the `create_file` MCP tool with the HTML content as an
argument, which fails past a certain file size.

With `publish.py` built and the service account provisioned: the skill runs
`python publish.py output/findigs_gtm_executive_dashboard_<as_of>.html` as a normal
subprocess step (same posture as running `build.py` or `qa.py`), reads the printed
`webViewLink` from stdout, and uses that as `<DRIVE_LINK>` in `slack_post.txt`. The
"built but not published" outcome (skill step 6, item 4) would only trigger on a
real `publish.py` failure (auth error, network error, permission error) — which
should be rare — rather than on every run past the current size ceiling, which is
today's actual failure mode.

## Open items before this can be built

1. Someone with GCP admin access needs to create the service account and scope it.
2. Someone with Shared Drive admin access needs to add it as a Content Manager
   member of the Shared Drive (not just the subfolder).
3. Confirm how this account's Claude Code Routines actually expose an environment
   secret to a running skill — I don't know that mechanism and shouldn't guess it
   into the spec.
4. Confirm the Routine's sandboxed execution environment permits outbound HTTPS to
   `www.googleapis.com` / `oauth2.googleapis.com` (this repo's own proxy setup
   suggests it should, but it's worth confirming for a real script rather than an
   MCP tool call).

Once those four are answered, `publish.py` itself is a small, standard resumable-
upload script — no design risk, just execution. I'm not writing it until you say go.
