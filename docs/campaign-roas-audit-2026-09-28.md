# Campaign ROAS and decisions audit — 28 September 2026

Scope: Campaigns' store/collection/Google metrics, collection membership, first-visit evidence, decision windows, scale/reduce guards, active budget totals, UI and existing control boundaries. No ad budgets or statuses were changed by this audit.

## Findings fixed

- Historical collection membership could omit a new active campaign and mark the collection inactive. Membership now includes the current campaign inventory. Missing or changed associations withhold collection totals and margin-based decisions.
- Google start dates were not passed to the decision engine. Pre-launch zero-filled days could count towards the five-day minimum. Windows now exclude the start day and preceding days; campaigns launched today await their first complete day.
- Orders containing collection products but lacking a first visit were excluded silently, potentially making unknown attribution look like zero. The reader now recognises that gap in both old snapshots and new completeness flags, while preserving measured Google figures independently.
- Primary ROAS and decision ROAS had different periods but insufficient visible context. Each metric now names its selected period; the separate decision panel names its closed-day period.
- Store daily budgets included paused campaigns. The total now includes enabled campaigns only and is labelled accordingly, preserving currency guards.
- Duplicate campaign identities, repeated daily rows and mixed hourly/daily decision data cannot contribute twice. Partial current campaign inventory, stale/future refresh timestamps and incomplete source evidence cannot produce scale/reduce recommendations. Equally covering ready snapshots take precedence over partial ones.

## Rules retained and checked

- Individual Google ROAS uses conversion value and spend for the exact Google account and campaign ID; no distribution of collection sales among Google campaigns.
- Collection ROAS includes net line-item revenue only for products in that collection when the customer's first visit landed on the collection page. All channels qualify. Unrelated products and arrivals through other collections stay outside this metric.
- Collection shares aggregate once, not once per visible campaign. Store totals remain distinct. Changing the decision filter does not change full collection/store totals.
- Monetary ratios use one reporting currency. Google daily budgets retain their original account currency; mixed currencies do not produce a fabricated total.
- Decisions use complete days after the latest verified Dropscale action, excluding today and the action day. Without a verified action they use at most seven closed reference days and remain explicitly provisional. The Google start date also bounds the window.
- At least five complete days, current source evidence, valid costs and a positive estimated margin are required for scale/reduce. Zero Google attribution prompts measurement review. No recommendation executes an ad action.
- Existing authenticated, ownership-scoped and audited ad controls are unchanged.

## Validation

276 tests passed in 18 targeted suites, including actual Google/source identity and currency handling, Shopify sales and collection membership, snapshot ownership/authority, decision guards, existing control routes and UI. Typecheck and changed-file lint passed. Production-mode Cloudflare build and exact-SHA deployment are checked separately at publication.

Read-only production evidence for the reported store reproduced the independent Google campaign figures and the first-visit collection exclusion. The active Mary Jane campaign's Google start date is 28 September; the fixed engine classifies it and its collection as awaiting complete days. Local UI filters and expandable explanations were exercised with clearly labelled synthetic data and disabled ad controls.

## Remaining limits

Google conversion attribution and delays remain upstream evidence, not a guarantee that every sale was tracked. Direct changes made in Google Ads are not imported into Dropscale's action history. Costs and break-even may use configured estimates. The UI states these limits; signals are guidance for the media buyer.
