# Answers to Base44's Part 0 inventory questions (2026-11-24)

Base44 completed the inventory without touching anything and asked eight questions plus a go/no-go on the restore point. Decisions below, with the reasoning, then a paste-ready reply.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Stacked funnel card vs new pipeline view | **Keep the new single stacked-graph card visible. No legacy flag.** The "pipeline view" is the existing Sales pipeline tile group plus the existing funnel card plus two additions: the week-over-week waterfall and the per-stage table with WoW deltas. Add only a "Deals (count)" tile if the group lacks one, and the absolute WoW change on every tile in the group. | Tonight's card already shows count, $ and units stacked by pipeline, which is what B4's measure tiles and funnels were for. Duplicating it would clutter the page. The existing Qualified checkbox is the segmented control. |
| 2 | Qualified = NL Intro only (current) or first stage of both pipelines (A2) | **First stage of both pipelines, stored as `first_stage_ids: ["3753890497","3752297191"]` in config.** Toggle default stays on. | Brian's "Stage 1 vs Stage 2+" is generic, and the definition will be a Notion row read by executives who see one pipeline table. Impact today: 2 Upsell deals, $1,379,283, 20,272 units (Maymont Homes pet verification $1.356M and Cowboy Properties $23K) move from qualified to unqualified. If Will prefers his tonight's choice because upsell intros are existing customers, set `first_stage_ids` to the New Logo ID only; the config key makes either answer a one-line change. |
| 3 | New config keys | **Yes, add `config.ui` and `config.provisional` as new keys only.** Nothing existing changes. `show_legacy_pipeline_group` is not needed after decision 1; create `config.ui` anyway for future flags. | |
| 4 | Slack | **Leave Slack out entirely for now.** Interpretations stop at draft → approve inside the app. No channel posting, no threading. | The weekly Claude Routine still posts to #gtm_leadership; the Go-To-Market pre-read is another system. Two posters would collide. Revisit after four approved weeks. |
| 5 | Pulse badges blank until history has the new keys | **Acceptable.** Do not backfill or fabricate. Badges appear from the next reconciled refresh. | Only one as_of has retained deal rows, so there is nothing legitimate to recompute for earlier weeks. |
| 6 | Missing client-health properties: fail or degrade | **Degrade.** If any client-health company property or the Customer / Churn lifecycle stage is missing: skip Part A6, record it in `schema_check`, raise CH-0 (High), and render the Client health section in an "unavailable: {what's missing}" state. The deal sections still reconcile and publish. | Client health is provisional; it must not hold the reconciled deal metrics hostage. The configured deal properties keep their fail-fast behavior. |
| 7 | Meeting source buckets complete? | **Add one: `UK - Unknown` → Unknown.** Full `deal_source__c` enumeration from HubSpot (17 values): IB - Paid Search, IB - Paid Social, IB - Organic Search, IB - Organic Social, IB - Referral Traffic, IB - Rental History Q, IB - Marketing Email, IB - Direct (Unattributed) → Inbound; OB - SDR → SDR; OB - AE → AE; EV - Event → Event; RE - Employee / Investor / Customer / Partner Referral → Referral; DA - Data provider → Data provider; UK - Unknown → Unknown; blank → Unassigned. Store the mapping in `config.provisional.meetings.source_buckets`; bucket anything unrecognized as Unassigned and raise MT-2 (Low) naming the value. | Verified against the property definition on 2026-11-23. |
| 8 | Retention rule | **Keep the code's rule: deal rows for the 3 most recent reconciled snapshots (current + previous 2).** Update the doc to match. | Movement only needs the previous one. |
| 0.3 | Restore point | **Go.** `GtmBuildBackup`, label "pre-scope-expansion 2026-11-24", then start Part A. | |

Two things from the inventory that are not questions but need action:

- **Nobody holds `gtm_leadership` or `revops_admin`.** Only the 5 admins can open either page. Ask Base44 to grant `revops_admin` to Will's account now, and give Will the list of executive-group users so he can assign `gtm_leadership` before the dashboard is shared.
- **The refresh falls back to a private-app token (`Hubspot_App_Key`) when the connector is absent.** Acceptable only if that key carries read scopes exclusively. Ask Base44 to confirm the key's scopes and to fail the run (not fall back) if the key has any write scope.

## Paste-ready reply to Base44

```
Thanks — inventory accepted. Go on 0.3: create GtmBuildBackup with label "pre-scope-expansion 2026-11-24" containing the GTM page sources, all seven Gtm entity schemas, both function sources, the workflow and the GtmConfig row. Then start Part A. Answers to 1–8:

1. Stacked funnel card: keep it visible, as built today. Do NOT add show_legacy_pipeline_group. The "pipeline view" in B4 is now: the existing Sales pipeline tile group + the existing stacked funnel card + two new components — the week-over-week waterfall and the per-stage table with WoW Δ deals / Δ $ / Δ units. In the existing tile group, add a "Deals (count)" tile only if there isn't one, and add the absolute WoW change next to the Compare vs badge on every tile in that group. The existing Qualified checkbox is the control that switches the whole view; don't add a second one.

2. Qualified definition: first stage of BOTH pipelines. Add config.provisional.qualified = { first_stage_ids: ["3753890497", "3752297191"], label: "Qualified (Stage 2+)" } and make the existing client-side toggle read that key instead of the hardcoded New Logo ID. Default stays on. I know this moves 2 Upsell deals ($1,379,283 / 20,272 units) out of qualified today; that's intended. Show the provisional badge on the toggle.

3. Config: yes — add config.ui and config.provisional as new top-level keys. Touch none of the 19 existing keys.

4. Slack: leave it out completely. No posting, no threading, no connector. Interpretations go draft → approve inside the app only (B2 and the Runs page). I'll decide on posting after four approved weeks.

5. A5: acceptable. New pulse tiles show values with blank badges until a new GtmKpiHistory row lands. Do not backfill, estimate or synthesize history rows.

6. A6: degrade, don't fail. If any client-health company property or the Customer/Churn lifecycle stage IDs are missing, skip A6, record what's missing in schema_check, add DQ flag CH-0 (High, section client_health) and render the Client health section in an "unavailable — {missing items}" state. Deal properties keep their existing fail-fast behavior.

7. A4 buckets: add "UK - Unknown" → Unknown. The complete deal_source__c enumeration is: IB - Paid Search, IB - Paid Social, IB - Organic Search, IB - Organic Social, IB - Referral Traffic, IB - Rental History Q, IB - Marketing Email, IB - Direct (Unattributed) → Inbound; OB - SDR → SDR; OB - AE → AE; EV - Event → Event; RE - Employee Referral, RE - Investor Referral, RE - Customer Referral, RE - Partner Referral → Referral; DA - Data provider → Data provider; UK - Unknown → Unknown; blank → Unassigned. Store this mapping in config.provisional.meetings.source_buckets and read it at run time. Any value not in the map → Unassigned plus DQ flag MT-2 (Low) naming the value.

8. Retention: keep your current rule — GtmDeal rows for the 3 most recent reconciled snapshots (current + previous 2). State it that way in the methodology.

Two more items from your inventory:
9. Access: grant revops_admin to my account now. Then list the users in the executive group so I can tell you who gets gtm_leadership before the page is shared.
10. Hubspot_App_Key fallback: confirm the scopes on that private-app key. If it has ANY write scope, change the code to fail the run when the connector is absent instead of falling back. Read-only fallback is fine; log a stage note either way.

Proceed with Part A after the backup is created. After Part A, re-run the 0.1 inventory on touched items and report the diff before starting Part B.
```
