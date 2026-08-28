/**
 * Talking to the supplier's ERP — the part that has no idea whose session it is.
 *
 * Two things sign in to hsterp.com now: the agency, for its own commission
 * statement, and each client, for the costs of their own shop. The exchange is
 * identical; only the storage differs. Keeping it here means a change to how
 * HST authenticates is one edit, not two that can drift apart.
 */

const LOGIN_URL = "https://hsterp.com/login";
const REFRESH_URL = "https://hsterp.com/refresh-token";

/** Renew a little before the token actually dies, not at the last second. */
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export type HstSession = {
  accessToken: string;
  refreshToken: string | null;
  /** As HST words it — parse with parseExpiry before storing. */
  expires: string | null;
};

export class HstError extends Error {
  /**
   * HST refused the token (401/403).
   *
   * Separated from every other failure because it is the only one we can act
   * on: a refused token can be renewed and the request retried, whereas a 500
   * or a parser mismatch cannot. Before this flag existed, a refusal ended the
   * sync and the only way back was a human pasting a fresh login out of F12.
   */
  readonly unauthorized: boolean;

  constructor(message: string, unauthorized = false) {
    super(message);
    this.name = "HstError";
    this.unauthorized = unauthorized;
  }
}

/** The headers the ERP's own front end sends; it answers HTML without them. */
function erpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    lang: "en",
    ...extra,
  };
}

function readSession(body: unknown): HstSession | null {
  const data = ((body as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<
    string,
    unknown
  >;
  const accessToken = (data.accessToken ?? data.token) as string | undefined;
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: (data.refreshToken as string) ?? null,
    expires: (data.expires as string) ?? null,
  };
}

/**
 * Sign in with an account's own credentials.
 *
 * The ERP's login form carries a captcha field. Whatever it is passed is what
 * the person connecting typed — nothing here ships a canned answer to it, and
 * none belongs here: if HST is checking the code, they can read it off the
 * screen, and if HST is not, an empty field is the truthful thing to send. A
 * hardcoded value would be a claim to have passed a check nobody made.
 */
export async function hstLogin(credentials: {
  username: string;
  password: string;
  captchaCode?: string;
}): Promise<HstSession> {
  let res: Response;
  try {
    res = await fetch(LOGIN_URL, {
      method: "POST",
      headers: erpHeaders(),
      body: JSON.stringify({
        username: credentials.username,
        password: credentials.password,
        captcha_code: credentials.captchaCode ?? "",
        captcha_key: "",
      }),
    });
  } catch {
    throw new HstError("Couldn't reach HST to sign in.");
  }

  if (res.status === 401 || res.status === 403) {
    throw new HstError("HST refused those credentials.");
  }
  if (!res.ok) throw new HstError(`HST returned ${res.status} when signing in.`);

  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  const session = readSession(body);
  if (!session) {
    // The ERP answers 200 with success:false for a bad password or a captcha it
    // did check. Its own message is the only thing that says which.
    throw new HstError(
      body?.message
        ? `HST did not sign in: ${body.message}`
        : "HST did not return a token for those credentials.",
    );
  }
  return session;
}

/** Swap a refresh token for a new session, or null when that is not possible. */
export async function hstRefresh(refreshToken: string): Promise<HstSession | null> {
  let res: Response;
  try {
    res = await fetch(REFRESH_URL, { method: "POST", headers: erpHeaders(), body: JSON.stringify({ refreshToken }) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  return readSession(await res.json().catch(() => null));
}

/**
 * Call an ERP endpoint with a bearer token.
 *
 * A 200 carrying HTML means the URL is the ERP's own page rather than its API,
 * and res.json() would fail on "<" while saying nothing about why.
 */
export async function hstGet(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: erpHeaders({ Authorization: `Bearer ${token}` }),
  });

  if (res.status === 401 || res.status === 403) {
    throw new HstError("HST rejected the token — the session likely expired.", true);
  }
  if (!res.ok) throw new HstError(`HST returned ${res.status}.`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new HstError(
      `HST answered with "${contentType || "no content-type"}" instead of JSON.`,
    );
  }
  return res.json();
}
