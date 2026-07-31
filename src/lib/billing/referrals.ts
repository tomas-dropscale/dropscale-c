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

/** The fee never falls below this, however many clients somebody brings. */
export const REFERRAL_FLOOR_RATE = 5;
