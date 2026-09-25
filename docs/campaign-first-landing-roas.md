# Campaign ROAS from first collection visits

The Campaigns page and store Analytics campaign P&L use Shopify order first-visit evidence. This is the first visit recorded in the order's customer journey, not a claim about the customer's lifetime first visit.

- Collection overall: net product-line sales from that collection, only if the first visit landed on its collection page. All channels count. Other basket items, shipping and sales whose first landing was elsewhere or unknown are excluded.
- Campaign individual: the same collection-line rule plus evidence of a paid Google visit and an unambiguous campaign ID or unique exact campaign name. Google conversion value remains a separately labelled comparison.
- Google click IDs prove paid origin but do not identify a campaign by themselves. An unresolved Google source or missing/ambiguous campaign identity keeps the affected collection's individual ROAS unavailable, including for members with zero allocation weight. It does not print a misleading zero.
- Discounts and line refunds use the existing Shopify line amounts. Revenue is converted using the order day's rate into the store reporting currency before summing. Orders use the purchase date. Collection membership is the current verified membership available to reporting; historical membership is not reconstructed.
- Collection shares are transport values for grouping: they sum back to one collection total. Individual campaign revenue is never apportioned by spend. Overall divides by all campaigns' spend for that collection; individual divides by that campaign's spend.
- Old or incomplete first-visit snapshots show unavailable, without falling back to all collection sales or Google conversion values. The Campaigns page reads exact-range, authority-checked stored snapshots, without provider calls during rendering. It shows the sales snapshot timestamp.
- Campaign P&L applies available costs to the same selected product lines, and estimates fees using existing settings. Cart conversion is unavailable because existing cart data uses a different attribution model.

For future Google Ads traffic, the final URL suffix can supply `utm_source=google&utm_medium=cpc&utm_campaign={campaignid}`. Existing suffixes must be preserved when adding these fields. No ad URLs or tracking settings are changed by this reporting release, and missing historical campaign identity cannot be recovered from the available first-visit data.

This change does not modify billing, revenue share, invoices, store-level rollup revenue or the daily report's global attribution rules. The existing hourly reporting refresh produces the new fields for its normal windows; store Analytics Sync refreshes a selected period.
