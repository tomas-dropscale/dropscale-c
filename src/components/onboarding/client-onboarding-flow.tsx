"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  Link2,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
} from "lucide-react";

import { FormAlert } from "@/components/auth/auth-card";
import { GoogleButton } from "@/components/auth/google-button";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { REPORTING_SHOPIFY_SCOPES_TEXT } from "@/lib/client-onboarding/shopify-scopes";
import type { ClientOnboardingSessionDTO } from "@/lib/client-onboarding/sessions";
import { authRedirect } from "@/lib/site";
import { createClient as createBrowserSupabaseClient } from "@/lib/supabase/client";
import { authErrorMessage } from "@/lib/validations/auth";

type Step = 1 | 2 | 3;
type Feedback = { tone: "error" | "success"; message: string } | null;

class SessionFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SessionFetchError";
  }
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function requestsShopify(session: ClientOnboardingSessionDTO) {
  return session.requestedAssets.includes("shopify");
}

function requestsGoogle(session: ClientOnboardingSessionDTO) {
  return session.requestedAssets.includes("google_ads");
}

function hasCurrentShopify(session: ClientOnboardingSessionDTO) {
  return session.mode === "reconnect"
    ? Boolean(session.reconnectCompletedAt)
    : session.shopify.some((store) => store.sessionId === session.id);
}

function hasCurrentGoogleAds(session: ClientOnboardingSessionDTO) {
  return session.googleAds.some((account) => account.sessionId === session.id);
}

function responseError(body: unknown, fallback: string) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string") return error;
  }
  return fallback;
}

function requestedSteps(session: ClientOnboardingSessionDTO): Step[] {
  return [
    1,
    ...(requestsShopify(session) ? ([2] as const) : []),
    ...(requestsGoogle(session) ? ([3] as const) : []),
  ];
}

function suggestedStep(session: ClientOnboardingSessionDTO): Step {
  if (!session.claimedUserId) return 1;
  if (requestsShopify(session) && !hasCurrentShopify(session)) return 2;
  if (requestsGoogle(session) && !hasCurrentGoogleAds(session)) return 3;
  return requestsGoogle(session) ? 3 : requestsShopify(session) ? 2 : 1;
}

function Stepper({
  session,
  step,
}: {
  session: ClientOnboardingSessionDTO;
  step: Step;
}) {
  const steps = requestedSteps(session);
  const labels: Record<Step, string> = {
    1: "Account",
    2: "Shopify",
    3: "Google Ads",
  };
  return (
    <ol
      className={`grid gap-2 ${
        steps.length === 1
          ? "sm:grid-cols-1"
          : steps.length === 2
            ? "sm:grid-cols-2"
            : "sm:grid-cols-3"
      }`}
      aria-label="Onboarding progress"
    >
      {steps.map((number, index) => {
        const active = number === step;
        const complete =
          number < step || (number === 1 && Boolean(session.claimedUserId));
        return (
          <li
            key={number}
            aria-current={active ? "step" : undefined}
            className={`rounded-[12px] border px-3 py-3 ${
              active
                ? "border-[var(--accent-gold)]/40 bg-[var(--accent-gold-dim)]"
                : "border-[var(--border-subtle)] bg-[var(--bg-base)]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`flex size-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                  complete
                    ? "bg-[var(--success-green)]/12 text-[var(--success-green)]"
                    : "bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
                }`}
              >
                {complete ? (
                  <Check className="size-3.5" aria-hidden />
                ) : (
                  index + 1
                )}
              </span>
              <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                {labels[number]}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ExistingClientSignIn({
  sessionId,
  login,
  busy,
  onLoginChange,
  onSubmit,
  onGoogleError,
}: {
  sessionId: string;
  login: { email: string; password: string };
  busy: boolean;
  onLoginChange: (login: { email: string; password: string }) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onGoogleError: (message: string) => void;
}) {
  return (
    <>
      <GoogleButton
        redirectTo={authRedirect(`/onboarding/client/${sessionId}`)}
        onError={onGoogleError}
      />
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="existing-email">Email</Label>
          <Input
            id="existing-email"
            type="email"
            autoComplete="email"
            value={login.email}
            onChange={(event) =>
              onLoginChange({ ...login, email: event.target.value })
            }
            required
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="existing-password">Password</Label>
            <Link
              href={`/forgot-password?next=${encodeURIComponent(
                `/onboarding/client/${sessionId}`,
              )}`}
              className="text-[11.5px] font-medium text-[var(--accent-gold)] transition-colors hover:text-[var(--accent-gold-strong)]"
            >
              Forgot password?
            </Link>
          </div>
          <PasswordInput
            id="existing-password"
            autoComplete="current-password"
            value={login.password}
            onChange={(event) =>
              onLoginChange({ ...login, password: event.target.value })
            }
            required
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          loading={busy}
        >
          Verify and continue
        </Button>
      </form>
    </>
  );
}

export function ClientOnboardingFlow({ sessionId }: { sessionId: string }) {
  const tokenRef = React.useRef("");
  const autoClaimRef = React.useRef("");
  const [session, setSession] =
    React.useState<ClientOnboardingSessionDTO | null>(null);
  const [linkState, setLinkState] = React.useState<
    "checking" | "valid" | "reauthenticate" | "invalid"
  >("checking");
  const [linkError, setLinkError] = React.useState("");
  const [step, setStep] = React.useState<Step>(1);
  const [busy, setBusy] = React.useState(false);
  const [authChecking, setAuthChecking] = React.useState(true);
  const [feedback, setFeedback] = React.useState<Feedback>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);

  const [account, setAccount] = React.useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [existingLogin, setExistingLogin] = React.useState({
    email: "",
    password: "",
  });
  const [needsEmailConfirmation, setNeedsEmailConfirmation] =
    React.useState(false);
  const [shopify, setShopify] = React.useState({
    domain: "",
    clientId: "",
    clientSecret: "",
  });
  const [copiedScopes, setCopiedScopes] = React.useState(false);
  const [windsorUrl, setWindsorUrl] = React.useState("");
  const [polling, setPolling] = React.useState(false);
  const [mappings, setMappings] = React.useState<Record<string, string>>({});
  const [complete, setComplete] = React.useState(false);

  const currentGoogleAccounts = React.useMemo(
    () =>
      session?.googleAds.filter(
        (accountItem) => accountItem.sessionId === session.id,
      ) ?? [],
    [session],
  );
  const currentShopifyStores = React.useMemo(
    () =>
      session?.shopify.filter(
        (storeItem) => storeItem.sessionId === session.id,
      ) ?? [],
    [session],
  );
  const previousGoogleAccounts = React.useMemo(
    () =>
      session?.googleAds.filter(
        (accountItem) => accountItem.sessionId !== session.id,
      ) ?? [],
    [session],
  );

  const fetchSession = React.useCallback(
    async (tokenValue = tokenRef.current) => {
      const response = await fetch(`/api/client-onboarding/${sessionId}`, {
        method: "GET",
        cache: "no-store",
        headers: tokenValue
          ? { "x-dropscale-client-onboarding": tokenValue }
          : undefined,
      });
      const body = (await response.json().catch(() => null)) as {
        session?: ClientOnboardingSessionDTO;
        error?: string;
      } | null;
      if (!response.ok || !body?.session) {
        throw new SessionFetchError(
          responseError(body, "This onboarding link is no longer available."),
          response.status,
        );
      }
      const nextSession = body.session;
      setSession(nextSession);
      if (nextSession.reconnectTarget && !nextSession.reconnectCompletedAt) {
        setShopify((current) => ({
          ...current,
          domain: nextSession.reconnectTarget?.domain ?? current.domain,
        }));
      }
      if (["submitted", "reviewed", "active"].includes(nextSession.rawStatus)) {
        setComplete(true);
      } else {
        setStep((current) =>
          current === 1 && nextSession.claimedUserId
            ? suggestedStep(nextSession)
            : current,
        );
      }
      const initialMappings: Record<string, string> = {};
      for (const mapping of nextSession.mappings) {
        initialMappings[mapping.googleAdsConnectionId] =
          mapping.shopifyConnectionId;
      }
      setMappings(initialMappings);
      return nextSession;
    },
    [sessionId],
  );

  React.useEffect(() => {
    let active = true;
    const fragment = window.location.hash.slice(1);
    const token = TOKEN.test(fragment) ? fragment : tokenRef.current;
    if (fragment) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
    tokenRef.current = token;
    void fetchSession(token)
      .then(() => {
        if (active) setLinkState("valid");
      })
      .catch((error: unknown) => {
        if (!active) return;
        const shouldReauthenticate =
          !token &&
          error instanceof SessionFetchError &&
          (error.status === 401 || error.status === 403);
        setLinkState(shouldReauthenticate ? "reauthenticate" : "invalid");
        setLinkError(
          shouldReauthenticate
            ? "Sign in with the account that received this invitation."
            : error instanceof Error
            ? error.message
            : "This onboarding link is invalid.",
        );
      });

    return () => {
      active = false;
    };
  }, [fetchSession]);

  React.useEffect(() => {
    if (linkState === "valid") headingRef.current?.focus();
  }, [step, linkState]);

  const requestHeaders = React.useCallback(
    (json = true): HeadersInit => ({
      ...(json ? { "content-type": "application/json" } : {}),
      ...(tokenRef.current
        ? { "x-dropscale-client-onboarding": tokenRef.current }
        : {}),
    }),
    [],
  );

  const claimExistingAccount = React.useCallback(async () => {
    const response = await fetch(
      `/api/client-onboarding/${sessionId}/account`,
      {
        method: "POST",
        cache: "no-store",
        headers: requestHeaders(),
        body: JSON.stringify({ kind: "existing" }),
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        responseError(body, "This client account could not be verified."),
      );
    }
    const updated = await fetchSession();
    setLinkState("valid");
    setStep(suggestedStep(updated));
    return updated;
  }, [fetchSession, requestHeaders, sessionId]);

  React.useEffect(() => {
    if (
      linkState !== "valid" ||
      !session ||
      session.mode === "new_client" ||
      session.claimedUserId ||
      autoClaimRef.current === session.id
    ) {
      return;
    }

    let active = true;
    setAuthChecking(true);
    void Promise.resolve()
      .then(() => createBrowserSupabaseClient().auth.getUser())
      .then(async ({ data, error }) => {
        if (!active || error || !data.user) return;
        autoClaimRef.current = session.id;
        try {
          await claimExistingAccount();
          if (active) {
            setFeedback({ tone: "success", message: "Account verified." });
          }
        } catch (claimError) {
          if (active) {
            setFeedback({
              tone: "error",
              message:
                claimError instanceof Error
                  ? claimError.message
                  : "This client account could not be verified.",
            });
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setAuthChecking(false);
      });

    return () => {
      active = false;
    };
  }, [claimExistingAccount, linkState, session]);

  async function createAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (account.password !== account.confirmPassword) {
      setFeedback({ tone: "error", message: "The passwords do not match." });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const { data: signup, error: signupError } = await supabase.auth.signUp({
        email: account.email.trim(),
        password: account.password,
        options: {
          data: {
            full_name: `${account.firstName.trim()} ${account.lastName.trim()}`,
            client_onboarding_id: sessionId,
          },
          emailRedirectTo: authRedirect(`/onboarding/client/${sessionId}`),
        },
      });
      let recovery = false;
      let userId = signup.user?.id ?? null;
      if (
        signupError ||
        !signup.user ||
        (signup.user.identities?.length ?? 0) === 0
      ) {
        const { data: signedIn, error: signInError } =
          await supabase.auth.signInWithPassword({
            email: account.email.trim(),
            password: account.password,
          });
        if (signInError || !signedIn.user) {
          throw new Error(
            "That email already has a Dropscale account. If you just created it, confirm the email first and retry with the same password; otherwise ask for an Add assets link.",
          );
        }
        recovery = true;
        userId = signedIn.user.id;
      }
      setAccount((value) => ({ ...value, password: "", confirmPassword: "" }));
      const response = await fetch(
        `/api/client-onboarding/${sessionId}/account`,
        {
          method: "POST",
          cache: "no-store",
          headers: requestHeaders(),
          body: JSON.stringify({
            kind: recovery ? "recover" : "new",
            firstName: account.firstName,
            lastName: account.lastName,
            email: account.email,
            ...(recovery ? {} : { userId }),
          }),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        needsEmailConfirmation?: boolean;
      } | null;
      if (!response.ok)
        throw new Error(
          responseError(body, "The account could not be created."),
        );
      setNeedsEmailConfirmation(Boolean(body?.needsEmailConfirmation));
      const updated = await fetchSession();
      setStep(suggestedStep(updated));
      setFeedback({
        tone: "success",
        message: body?.needsEmailConfirmation
          ? session?.requestedAssets.length
            ? "Account created. Check your inbox to confirm the email while you continue connecting assets."
            : "Account created. Check your inbox to confirm the email, then submit the account for review."
          : session?.requestedAssets.length
            ? "Account created successfully. Continue with the requested connections."
            : "Account created successfully. It is ready to submit for review.",
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The account could not be created.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function signInExisting(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const { error } = await supabase.auth.signInWithPassword({
        email: existingLogin.email.trim(),
        password: existingLogin.password,
      });
      setExistingLogin((value) => ({ ...value, password: "" }));
      if (error) throw new Error(authErrorMessage(error));
      await claimExistingAccount();
      setFeedback({ tone: "success", message: "Account verified." });
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The client could not be verified.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function connectShopify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(
        `/api/client-onboarding/${sessionId}/shopify`,
        {
          method: "POST",
          cache: "no-store",
          headers: requestHeaders(),
          body: JSON.stringify({
            shopDomain: shopify.domain,
            shopifyClientId: shopify.clientId,
            clientSecret: shopify.clientSecret,
          }),
        },
      );
      const body = await response.json().catch(() => null);
      setShopify((value) => ({ ...value, clientSecret: "" }));
      if (!response.ok)
        throw new Error(
          responseError(body, "The Shopify store could not be connected."),
        );
      const updated = await fetchSession();
      setShopify({
        domain: updated.reconnectTarget?.domain ?? "",
        clientId: "",
        clientSecret: "",
      });
      setFeedback({
        tone: "success",
        message:
          "Shopify reporting access was verified with read-only probes and saved securely.",
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The Shopify store could not be connected.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function startWindsor() {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(
        `/api/client-onboarding/${sessionId}/windsor`,
        {
          method: "POST",
          cache: "no-store",
          headers: requestHeaders(false),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        authorizationUrl?: unknown;
      } | null;
      if (!response.ok || typeof body?.authorizationUrl !== "string") {
        throw new Error(
          responseError(body, "Google authorization could not be started."),
        );
      }
      setWindsorUrl(body.authorizationUrl);
      setFeedback({
        tone: "success",
        message:
          "Secure Google Ads authorization is ready. Open Windsor, finish the Google flow, then return here.",
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Google authorization could not be started.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function checkWindsor() {
    setPolling(true);
    setFeedback(null);
    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await fetch(
          `/api/client-onboarding/${sessionId}/windsor`,
          {
            method: "GET",
            cache: "no-store",
            headers: requestHeaders(false),
          },
        );
        const body = (await response.json().catch(() => null)) as {
          status?: string;
          accounts?: unknown[];
        } | null;
        if (!response.ok)
          throw new Error(
            responseError(body, "Google Ads could not be checked."),
          );
        if (body?.status === "connected" && (body.accounts?.length ?? 0) > 0) {
          await fetchSession();
          setFeedback({
            tone: "success",
            message: "Google Ads accounts connected successfully.",
          });
          return;
        }
        if (attempt < 5)
          await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      }
      setFeedback({
        tone: "error",
        message:
          "No completed Google Ads authorization was found yet. Make sure you clicked Finish in Windsor, then check again.",
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Google Ads could not be checked.",
      });
    } finally {
      setPolling(false);
    }
  }

  async function finishOnboarding() {
    if (!session) return;
    setBusy(true);
    setFeedback(null);
    try {
      const currentShopifyIds = new Set(
        currentShopifyStores.map((storeItem) => storeItem.id),
      );
      const canRemapPreviousGoogle =
        session.mode !== "reconnect" &&
        requestsShopify(session) &&
        !requestsGoogle(session);
      const mappingPayload = Object.entries(mappings).flatMap(
        ([googleAdsConnectionId, shopifyConnectionId]) => {
          const accountItem = session.googleAds.find(
            (account) => account.id === googleAdsConnectionId,
          );
          const editable = Boolean(
            accountItem &&
            (accountItem.sessionId === session.id ||
              (canRemapPreviousGoogle &&
                currentShopifyIds.has(shopifyConnectionId))),
          );
          return editable && shopifyConnectionId
            ? [{ googleAdsConnectionId, shopifyConnectionId }]
            : [];
        },
      );
      const canEditMappings =
        session.mode !== "reconnect" &&
        ((session.shopify.length > 0 && currentGoogleAccounts.length > 0) ||
        (canRemapPreviousGoogle &&
          currentShopifyStores.length > 0 &&
          previousGoogleAccounts.length > 0));
      if (canEditMappings) {
        const mappingResponse = await fetch(
          `/api/client-onboarding/${sessionId}/mappings`,
          {
            method: "PUT",
            cache: "no-store",
            headers: requestHeaders(),
            body: JSON.stringify({ mappings: mappingPayload }),
          },
        );
        const mappingBody = await mappingResponse.json().catch(() => null);
        if (!mappingResponse.ok) {
          throw new Error(
            responseError(
              mappingBody,
              "The store mappings could not be saved.",
            ),
          );
        }
      }
      const response = await fetch(`/api/client-onboarding/${sessionId}`, {
        method: "POST",
        cache: "no-store",
        headers: requestHeaders(),
        body: JSON.stringify({ action: "submit" }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          responseError(body, "The onboarding could not be submitted."),
        );
      tokenRef.current = "";
      setComplete(true);
      setFeedback(null);
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The onboarding could not be submitted.",
      });
    } finally {
      setBusy(false);
    }
  }

  function nextStep() {
    if (!session) return;
    const steps = requestedSteps(session);
    const index = steps.indexOf(step);
    const next = steps[index + 1];
    if (next) setStep(next);
    else void finishOnboarding();
  }

  function previousStep() {
    if (!session) return;
    const steps = requestedSteps(session);
    const index = steps.indexOf(step);
    const previous = steps[index - 1];
    if (previous && !(previous === 1 && session.claimedUserId))
      setStep(previous);
  }

  if (linkState === "checking") {
    return (
      <section className="panel p-8 text-center" aria-live="polite">
        <RefreshCw
          className="mx-auto size-5 animate-spin text-[var(--accent-gold)]"
          aria-hidden
        />
        <p className="mt-3 text-[13px] font-medium text-[var(--text-primary)]">
          Checking the secure onboarding link…
        </p>
      </section>
    );
  }

  if (linkState === "reauthenticate") {
    return (
      <section className="panel mx-auto max-w-xl p-6 sm:p-8">
        <div className="space-y-5">
          <FormAlert>{linkError}</FormAlert>
          {feedback && <FormAlert>{feedback.message}</FormAlert>}
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">
              Choose the invited account
            </h1>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
              You may be signed in with a different account. Choose the Google
              account that received this link, or sign in with its email and
              password.
            </p>
          </div>
          <ExistingClientSignIn
            sessionId={sessionId}
            login={existingLogin}
            busy={busy}
            onLoginChange={setExistingLogin}
            onSubmit={signInExisting}
            onGoogleError={(message) =>
              setLinkError(authErrorMessage({ message }))
            }
          />
        </div>
      </section>
    );
  }

  if (linkState === "invalid" || !session) {
    return (
      <section className="panel mx-auto max-w-xl p-6 sm:p-8">
        <FormAlert>{linkError}</FormAlert>
      </section>
    );
  }

  if (complete) {
    return (
      <section className="panel mx-auto max-w-2xl p-6 text-center sm:p-8">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-[var(--success-green)]/12 text-[var(--success-green)]">
          <CheckCircle2 className="size-6" aria-hidden />
        </span>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-[var(--text-primary)]">
          Setup submitted for review
        </h1>
        <p className="mx-auto mt-2 max-w-lg text-[13px] leading-relaxed text-[var(--text-secondary)]">
          Dropscale received your account
          {session.shopify.length || session.googleAds.length
            ? " and connected assets"
            : ""}
          . The team will review the setup before activating dashboard access.
          Connection checks and billing remain separate admin processes; billing
          was not started by this setup.
        </p>
        {needsEmailConfirmation && (
          <p className="mt-4 text-[12px] text-[var(--warning-orange)]">
            Remember to confirm the email we sent before the team can activate
            the account.
          </p>
        )}
      </section>
    );
  }

  const canLeaveShopify =
    !requestsShopify(session) || hasCurrentShopify(session);
  const canFinishGoogle =
    !requestsGoogle(session) || hasCurrentGoogleAds(session);

  return (
    <div className="space-y-4">
      <section className="panel p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]">
            <ShieldCheck className="size-5" aria-hidden />
          </span>
          <div>
            <p className="label-caps">Dropscale client onboarding</p>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="mt-1 text-xl font-semibold tracking-tight text-[var(--text-primary)] outline-none"
            >
              Set up your reporting workspace
            </h1>
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--text-secondary)]">
              Create or verify your portal identity, then complete only the
              reporting connections requested for this invitation. Some accounts
              do not need assets yet.
            </p>
          </div>
        </div>
        <div className="mt-5">
          <Stepper session={session} step={step} />
        </div>
      </section>

      {feedback &&
        (feedback.tone === "error" ? (
          <FormAlert>{feedback.message}</FormAlert>
        ) : (
          <div
            role="status"
            className="rounded-[var(--radius-card)] border border-[var(--success-green)]/25 bg-[var(--success-green)]/8 px-4 py-3 text-[12.5px] text-[var(--text-secondary)]"
          >
            {feedback.message}
          </div>
        ))}

      <section className="panel overflow-hidden">
        <div className="p-5 sm:p-7">
          {step === 1 &&
            !session.claimedUserId &&
            session.mode === "new_client" && (
              <form
                id="client-account-form"
                onSubmit={createAccount}
                className="space-y-4"
              >
                <div>
                  <p className="label-caps">Step 1</p>
                  <h2 className="mt-1 text-[17px] font-semibold text-[var(--text-primary)]">
                    Create your dashboard account
                  </h2>
                  <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
                    Enter your own details. Dropscale did not pre-fill an
                    identity for this link.
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="first-name">First name</Label>
                    <Input
                      id="first-name"
                      autoComplete="given-name"
                      value={account.firstName}
                      onChange={(event) =>
                        setAccount({
                          ...account,
                          firstName: event.target.value,
                        })
                      }
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="last-name">Last name</Label>
                    <Input
                      id="last-name"
                      autoComplete="family-name"
                      value={account.lastName}
                      onChange={(event) =>
                        setAccount({ ...account, lastName: event.target.value })
                      }
                      required
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="client-email">Email</Label>
                    <Input
                      id="client-email"
                      type="email"
                      autoComplete="email"
                      value={account.email}
                      onChange={(event) =>
                        setAccount({ ...account, email: event.target.value })
                      }
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="client-password">Password</Label>
                    <PasswordInput
                      id="client-password"
                      autoComplete="new-password"
                      value={account.password}
                      onChange={(event) =>
                        setAccount({ ...account, password: event.target.value })
                      }
                      minLength={8}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="client-confirm-password">
                      Confirm password
                    </Label>
                    <PasswordInput
                      id="client-confirm-password"
                      autoComplete="new-password"
                      value={account.confirmPassword}
                      onChange={(event) =>
                        setAccount({
                          ...account,
                          confirmPassword: event.target.value,
                        })
                      }
                      minLength={8}
                      required
                    />
                  </div>
                </div>
                <Button type="submit" variant="primary" loading={busy}>
                  Create account and continue
                  {!busy && <ArrowRight aria-hidden />}
                </Button>
              </form>
            )}

          {step === 1 &&
            !session.claimedUserId &&
            session.mode !== "new_client" && (
              <div className="mx-auto max-w-lg space-y-4">
                <div>
                  <p className="label-caps">Verify existing client</p>
                  <h2 className="mt-1 text-[17px] font-semibold text-[var(--text-primary)]">
                    Sign in to add or reconnect assets
                  </h2>
                  <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                    Use the account that received this invitation. If you
                    normally sign in with Google, continue with Google below.
                  </p>
                </div>
                {authChecking ? (
                  <div
                    className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-5 text-center"
                    role="status"
                    aria-live="polite"
                  >
                    <RefreshCw
                      className="mx-auto size-5 animate-spin text-[var(--accent-gold)]"
                      aria-hidden
                    />
                    <p className="mt-2 text-[12px] text-[var(--text-secondary)]">
                      Checking your signed-in account…
                    </p>
                  </div>
                ) : (
                  <>
                    <ExistingClientSignIn
                      sessionId={sessionId}
                      login={existingLogin}
                      busy={busy}
                      onLoginChange={setExistingLogin}
                      onSubmit={signInExisting}
                      onGoogleError={(message) =>
                        setFeedback({
                          tone: "error",
                          message: authErrorMessage({ message }),
                        })
                      }
                    />
                  </>
                )}
              </div>
            )}

          {step === 1 &&
            Boolean(session.claimedUserId) &&
            session.requestedAssets.length === 0 && (
              <div className="mx-auto max-w-xl text-center">
                <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-[var(--success-green)]/12 text-[var(--success-green)]">
                  <CheckCircle2 className="size-5" aria-hidden />
                </span>
                <p className="label-caps mt-4">Account only</p>
                <h2 className="mt-1 text-[17px] font-semibold text-[var(--text-primary)]">
                  Your dashboard account is ready for review
                </h2>
                <p className="mx-auto mt-2 max-w-md text-[12px] leading-relaxed text-[var(--text-secondary)]">
                  This invitation does not request a Shopify store or Google Ads
                  account. You can submit now; Dropscale can send a separate Add
                  assets link whenever those connections are needed.
                </p>
              </div>
            )}

          {step === 2 && (
            <div className="space-y-5">
              <div>
                <p className="label-caps">Step 2 · Shopify</p>
                <h2 className="mt-1 text-[17px] font-semibold text-[var(--text-primary)]">
                  {session.mode === "reconnect" && session.reconnectTarget
                    ? `Reconnect ${session.reconnectTarget.name}`
                    : "Connect your Shopify stores for reporting"}
                </h2>
                <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-[var(--text-secondary)]">
                  {session.mode === "reconnect" && session.reconnectTarget
                    ? `This invitation is locked to ${session.reconnectTarget.domain}. A different or additional store cannot be connected with this link.`
                    : "Shopify is connected directly to Dropscale, not Windsor. The app is read-only and covers orders and attribution, reports, products, inventory, locations, returns and Shopify Payments payouts."}
                </p>
              </div>

              {session.mode === "reconnect" && session.reconnectTarget && (
                <div className="rounded-[12px] border border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] p-4">
                  <div className="flex items-center gap-2">
                    <ShoppingBag
                      className="size-4 text-[var(--accent-gold-strong)]"
                      aria-hidden
                    />
                    <p className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
                      {session.reconnectTarget.name}
                    </p>
                  </div>
                  <p className="mt-1 truncate text-[11.5px] text-[var(--text-secondary)]">
                    {session.reconnectTarget.domain}
                    {session.reconnectTarget.currency
                      ? ` · ${session.reconnectTarget.currency}`
                      : ""}
                  </p>
                  <p className="mt-2 text-[10.5px] font-medium text-[var(--text-muted)]">
                    Exact store selected by Dropscale
                  </p>
                </div>
              )}

              {session.mode !== "reconnect" && session.shopify.length > 0 && (
                <ul className="grid gap-3 sm:grid-cols-2">
                  {session.shopify.map((storeItem) => (
                    <li
                      key={storeItem.id}
                      className="rounded-[12px] border border-[var(--success-green)]/20 bg-[var(--success-green)]/5 p-4"
                    >
                      <div className="flex items-center gap-2">
                        <ShoppingBag
                          className="size-4 text-[var(--success-green)]"
                          aria-hidden
                        />
                        <p className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
                          {storeItem.name}
                        </p>
                      </div>
                      <p className="mt-1 truncate text-[11.5px] text-[var(--text-secondary)]">
                        {storeItem.domain} · {storeItem.currency}
                      </p>
                      {storeItem.sessionId !== session.id && (
                        <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">
                          Already connected to this workspace
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {requestsShopify(session) &&
                session.mode !== "reconnect" &&
                !requestsGoogle(session) &&
                currentShopifyStores.length > 0 &&
                previousGoogleAccounts.length > 0 && (
                  <div className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
                    <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                      Match existing Google Ads accounts (optional)
                    </p>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                      Existing matches stay unchanged unless you explicitly move
                      an account to one of the stores connected in this
                      invitation.
                    </p>
                    <ul className="mt-4 space-y-3">
                      {previousGoogleAccounts.map((accountItem) => {
                        const savedMapping = session.mappings.find(
                          (mapping) =>
                            mapping.googleAdsConnectionId === accountItem.id,
                        );
                        const savedStore = session.shopify.find(
                          (storeItem) =>
                            storeItem.id === savedMapping?.shopifyConnectionId,
                        );
                        const selectedCurrentStore = currentShopifyStores.find(
                          (storeItem) =>
                            storeItem.id === mappings[accountItem.id],
                        );
                        return (
                          <li
                            key={accountItem.id}
                            className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-3"
                          >
                            <p className="text-[12.5px] font-medium text-[var(--text-primary)]">
                              {accountItem.accountName}
                            </p>
                            {savedStore?.sessionId !== session.id &&
                              savedStore && (
                                <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">
                                  Existing match (read-only): {savedStore.name}
                                </p>
                              )}
                            <Label
                              className="mt-3 block"
                              htmlFor={`${accountItem.id}-new-store`}
                            >
                              Move to a newly connected store
                            </Label>
                            <select
                              id={`${accountItem.id}-new-store`}
                              value={selectedCurrentStore?.id ?? ""}
                              onChange={(event) =>
                                setMappings((current) => ({
                                  ...current,
                                  [accountItem.id]:
                                    event.target.value ||
                                    (savedStore?.sessionId !== session.id
                                      ? (savedStore?.id ?? "")
                                      : ""),
                                }))
                              }
                              className="mt-1.5 h-10 w-full rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 text-[13px] text-[var(--text-primary)]"
                            >
                              <option value="">
                                {savedStore?.sessionId !== session.id &&
                                savedStore
                                  ? "Keep existing match"
                                  : savedStore
                                    ? "Remove store match"
                                    : "No store selected"}
                              </option>
                              {currentShopifyStores.map((storeItem) => (
                                <option key={storeItem.id} value={storeItem.id}>
                                  {storeItem.name}
                                </option>
                              ))}
                            </select>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

              <details className="rounded-[12px] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
                <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium text-[var(--text-primary)]">
                  Shopify app setup and exact permissions
                </summary>
                <div className="space-y-3 border-t border-[var(--border-subtle)] px-4 py-4 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                  <ol className="list-decimal space-y-2 pl-4">
                    <li>
                      Open the Shopify Dev Dashboard and create an app named
                      “Dropscale Reporting”.
                    </li>
                    <li>
                      Remove the embedded app URL and add the read-only scopes
                      below.
                    </li>
                    <li>
                      Copy the Client ID and Client Secret before installing the
                      app.
                    </li>
                    <li>
                      Install the latest app version on the correct store, then
                      return here.
                    </li>
                  </ol>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <code className="max-h-24 flex-1 overflow-auto rounded-[8px] bg-[var(--bg-panel)] p-2 text-[10.5px]">
                      {REPORTING_SHOPIFY_SCOPES_TEXT}
                    </code>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(REPORTING_SHOPIFY_SCOPES_TEXT)
                          .then(() => {
                            setCopiedScopes(true);
                            window.setTimeout(
                              () => setCopiedScopes(false),
                              2_000,
                            );
                          })
                      }
                    >
                      {copiedScopes ? (
                        <Check aria-hidden />
                      ) : (
                        <Clipboard aria-hidden />
                      )}
                      {copiedScopes ? "Copied" : "Copy scopes"}
                    </Button>
                  </div>
                  <p>
                    Historical orders and Shopify Payments scopes can require
                    extra Shopify approval and a compatible store/payment setup.
                    No write permission is accepted.
                  </p>
                  <Button asChild variant="secondary" size="sm">
                    <Link
                      href="https://dev.shopify.com/dashboard"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open Shopify Dev Dashboard <ExternalLink aria-hidden />
                    </Link>
                  </Button>
                </div>
              </details>

              {session.mode === "reconnect" && hasCurrentShopify(session) && (
                <div
                  role="status"
                  className="rounded-[12px] border border-[var(--success-green)]/25 bg-[var(--success-green)]/8 p-4 text-[12.5px] text-[var(--text-secondary)]"
                >
                  The selected Shopify store was verified and reconnected. No
                  other store was added.
                </div>
              )}

              {(session.mode !== "reconnect" || !hasCurrentShopify(session)) && (
                <form
                  onSubmit={connectShopify}
                  className="grid gap-4 rounded-[12px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4 sm:grid-cols-2"
                >
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="shop-domain">.myshopify.com domain</Label>
                  <Input
                    id="shop-domain"
                    placeholder="store-name.myshopify.com"
                    value={shopify.domain}
                    readOnly={session.mode === "reconnect"}
                    onChange={(event) =>
                      setShopify({ ...shopify, domain: event.target.value })
                    }
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="shop-client-id">Client ID</Label>
                  <Input
                    id="shop-client-id"
                    autoComplete="off"
                    value={shopify.clientId}
                    onChange={(event) =>
                      setShopify({ ...shopify, clientId: event.target.value })
                    }
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="shop-client-secret">Client Secret</Label>
                  <PasswordInput
                    id="shop-client-secret"
                    autoComplete="off"
                    value={shopify.clientSecret}
                    onChange={(event) =>
                      setShopify({
                        ...shopify,
                        clientSecret: event.target.value,
                      })
                    }
                    required
                  />
                </div>
                <div className="sm:col-span-2">
                  <Button type="submit" loading={busy}>
                    {session.mode === "reconnect" ? (
                      <RefreshCw aria-hidden />
                    ) : (
                      <Plus aria-hidden />
                    )}
                    {session.mode === "reconnect"
                      ? "Reconnect selected store"
                      : hasCurrentShopify(session)
                        ? "Connect another store"
                        : "Connect store"}
                  </Button>
                </div>
                </form>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <div>
                <p className="label-caps">Step 3 · Google Ads</p>
                <h2 className="mt-1 text-[17px] font-semibold text-[var(--text-primary)]">
                  Authorize Google Ads through Windsor
                </h2>
                <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-[var(--text-secondary)]">
                  Windsor handles only the Google authorization. The link is
                  restricted to Google Ads; after you click Finish, Dropscale
                  detects every account you selected.
                </p>
              </div>

              <div className="rounded-[14px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4 sm:flex sm:items-center sm:justify-between sm:gap-4">
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[#4285f4]/10 text-[#7cafff]">
                    <Link2 className="size-5" aria-hidden />
                  </span>
                  <div>
                    <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                      Secure Google account selection
                    </p>
                    <p className="mt-1 text-[11.5px] text-[var(--text-secondary)]">
                      You can repeat this with another Google login to add more
                      accounts.
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="primary"
                  className="mt-4 w-full sm:mt-0 sm:w-auto"
                  loading={busy}
                  onClick={() => void startWindsor()}
                >
                  {hasCurrentGoogleAds(session)
                    ? "Use another Google login"
                    : "Create Google link"}
                </Button>
              </div>

              <div className="rounded-[12px] border border-[var(--accent-gold)]/25 bg-[var(--accent-gold-dim)] p-4">
                <p className="text-[12.5px] font-medium text-[var(--text-primary)]">
                  {windsorUrl
                    ? "Open Windsor and complete Google authorization, then return here and check your accounts."
                    : "Already completed Google authorization? Check your accounts. Otherwise, create a Google link above."}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {windsorUrl && (
                    <Button asChild variant="primary">
                      <Link href={windsorUrl} target="_blank" rel="noreferrer">
                        Open Windsor <ExternalLink aria-hidden />
                      </Link>
                    </Button>
                  )}
                  <Button
                    type="button"
                    loading={polling}
                    onClick={() => void checkWindsor()}
                  >
                    <RefreshCw aria-hidden />Check accounts
                  </Button>
                </div>
              </div>

              {session.googleAds.length > 0 && (
                <ul className="space-y-3">
                  {session.googleAds.map((accountItem) => (
                    <li
                      key={accountItem.id}
                      className="rounded-[12px] border border-[var(--success-green)]/20 bg-[var(--bg-base)] p-4"
                    >
                      <div className="flex items-center gap-2">
                        <CheckCircle2
                          className="size-4 text-[var(--success-green)]"
                          aria-hidden
                        />
                        <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                          {accountItem.accountName}
                        </p>
                      </div>
                      <p className="mt-1 pl-6 text-[11.5px] text-[var(--text-secondary)]">
                        Customer ID {accountItem.customerId}
                        {accountItem.currency
                          ? ` · ${accountItem.currency}`
                          : ""}
                      </p>
                      {accountItem.sessionId !== session.id && (
                        <p className="mt-1 pl-6 text-[10.5px] text-[var(--text-muted)]">
                          Already connected to this workspace
                        </p>
                      )}
                      {session.shopify.length > 0 &&
                        accountItem.sessionId === session.id && (
                          <div className="mt-3 border-t border-[var(--border-subtle)] pt-3">
                            <Label htmlFor={`${accountItem.id}-store`}>
                              Match to store (optional)
                            </Label>
                            <select
                              id={`${accountItem.id}-store`}
                              value={mappings[accountItem.id] ?? ""}
                              onChange={(event) =>
                                setMappings((current) => ({
                                  ...current,
                                  [accountItem.id]: event.target.value,
                                }))
                              }
                              className="mt-1.5 h-10 w-full rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3 text-[13px] text-[var(--text-primary)]"
                            >
                              <option value="">No store selected</option>
                              {session.shopify.map((storeItem) => (
                                <option key={storeItem.id} value={storeItem.id}>
                                  {storeItem.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      {accountItem.sessionId !== session.id &&
                        mappings[accountItem.id] && (
                          <p className="mt-3 border-t border-[var(--border-subtle)] pt-3 text-[11.5px] text-[var(--text-secondary)]">
                            Existing store match (read-only):{" "}
                            {session.shopify.find(
                              (storeItem) =>
                                storeItem.id === mappings[accountItem.id],
                            )?.name ?? "Existing workspace store"}
                          </p>
                        )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {session.claimedUserId && (
          <div className="flex flex-col-reverse gap-3 border-t border-[var(--border-subtle)] bg-[var(--bg-base)]/45 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
            <Button
              type="button"
              variant="ghost"
              onClick={previousStep}
              disabled={step === requestedSteps(session)[0]}
            >
              <ArrowLeft aria-hidden /> Back
            </Button>
            <Button
              type="button"
              variant="primary"
              loading={busy}
              disabled={
                (step === 2 && !canLeaveShopify) ||
                (step === 3 && !canFinishGoogle)
              }
              onClick={nextStep}
            >
              {step === requestedSteps(session).at(-1)
                ? "Submit for review"
                : "Continue"}
              {!busy && <ArrowRight aria-hidden />}
            </Button>
          </div>
        )}
      </section>

      <div className="flex items-center justify-center gap-2 text-[11px] text-[var(--text-muted)]">
        <LockKeyhole className="size-3.5" aria-hidden />
        Invitation credentials remain in memory only · Billing is never started
        here
      </div>
    </div>
  );
}
