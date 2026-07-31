/**
 * The affiliate deal's numbers, mirrored from migration 0022.
 *
 * The database is the authority: `referral_step()` and `referral_floor()` are
 * what actually price every store, through the trigger that derives
 * commission_rate. These constants exist only so the UI can EXPLAIN the deal —
 * never to compute a rate, which is why nothing here does arithmetic on money.
 *
 * Change one and you must change the other. They are kept apart rather than
 * read from the database on every page because a copy that drifts shows the
 * wrong explanation, whereas a rate read from the wrong place bills the wrong
 * amount — and only the second is unrecoverable.
 */

/** Percentage points off the fee per active referral. */
export const REFERRAL_STEP_PCT = 0.5;

/**
 * The fee's floor (migration 0024). Zero: bring in enough clients and the
 * management fee disappears entirely — that is the offer, not a rounding edge.
 *
 * A floor limits how far the DISCOUNT goes. It must never be read as a minimum
 * price: 0022 shipped it that way and pushed every store priced below it UP,
 * which is the one direction a pricing bug must never take.
 */
export const REFERRAL_FLOOR_RATE = 0;

/** The standard fee a client starts on, before any referral. */
export const DEFAULT_FEE_RATE = 10;

/** How many referrals it takes to wipe the fee out from the standard rate. */
export const REFERRALS_TO_ZERO = DEFAULT_FEE_RATE / REFERRAL_STEP_PCT;
