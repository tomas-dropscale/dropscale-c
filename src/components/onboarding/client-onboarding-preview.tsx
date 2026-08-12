"use client";

import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleUserRound,
  ExternalLink,
  Link2,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Store,
  Trash2,
} from "lucide-react";

import { PasswordInput } from "@/components/auth/password-input";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Step = 1 | 2 | 3;
export type PreviewAssetChoice = "shopify" | "google" | "both";
export type PreviewInvitationMode = "new" | "reconnect" | "assets";

export type ClientOnboardingPreviewConfig = {
  mode: PreviewInvitationMode;
  assets: PreviewAssetChoice;
};

type AccountFields = {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmPassword: string;
};

type AccountErrors = Partial<Record<keyof AccountFields, string>>;

type PreviewStore = {
  id: string;
  name: string;
  domain: string;
};

type PreviewAdAccount = {
  id: string;
  name: string;
  customerId: string;
  storeId: string;
};

const STEPS = [
  {
    number: 1 as const,
    label: "Account",
    description: "Your dashboard access",
    icon: CircleUserRound,
  },
  {
    number: 2 as const,
    label: "Shopify",
    description: "Connect your stores",
    icon: ShoppingBag,
  },
  {
    number: 3 as const,
    label: "Google Ads",
    description: "Choose ad accounts",
    icon: RefreshCw,
  },
] satisfies ReadonlyArray<{
  number: Step;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
}>;

const STORE_FIXTURES = [
  { name: "Northwind Home", domain: "northwind-preview.myshopify.com" },
  { name: "Atlas Studio", domain: "atlas-preview.myshopify.com" },
  { name: "Cedar & Coast", domain: "cedar-preview.myshopify.com" },
];

const AD_ACCOUNT_FIXTURES = [
  { name: "Preview Search · Portugal", customerId: "123-456-7801" },
  { name: "Preview Shopping · Europe", customerId: "123-456-7802" },
  { name: "Preview Brand · Secondary login", customerId: "123-456-7803" },
  { name: "Preview Growth · Secondary login", customerId: "123-456-7804" },
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function requestsShopify(choice: PreviewAssetChoice) {
  return choice === "shopify" || choice === "both";
}

function requestsGoogle(choice: PreviewAssetChoice) {
  return choice === "google" || choice === "both";
}

function firstAssetStep(config: ClientOnboardingPreviewConfig): Step {
  return requestsShopify(config.assets) ? 2 : 3;
}

function validateAccount(fields: AccountFields): AccountErrors {
  const errors: AccountErrors = {};

  if (!fields.firstName.trim()) errors.firstName = "Enter your first name.";
  if (!fields.lastName.trim()) errors.lastName = "Enter your last name.";
  if (!EMAIL_PATTERN.test(fields.email.trim())) errors.email = "Enter a valid email address.";
  if (fields.password.length < 8) errors.password = "Use at least 8 characters.";
  if (!fields.confirmPassword) {
    errors.confirmPassword = "Confirm your password.";
  } else if (fields.confirmPassword !== fields.password) {
    errors.confirmPassword = "The passwords do not match.";
  }

  return errors;
}

function Stepper({
  step,
  complete,
  config,
}: {
  step: Step;
  complete: boolean;
  config: ClientOnboardingPreviewConfig;
}) {
  return (
    <nav aria-label="Onboarding progress">
      <ol className="grid grid-cols-3 gap-2 lg:grid-cols-1 lg:gap-1">
        {STEPS.map(({ number, label, description, icon: Icon }) => {
          const isRelevant =
            number === 1
              ? config.mode === "new"
              : number === 2
                ? requestsShopify(config.assets)
                : requestsGoogle(config.assets);
          const isCurrent = !complete && isRelevant && step === number;
          const isDone = complete || !isRelevant || step > number;
          const stepDescription = !isRelevant
            ? number === 1
              ? "Existing account preserved"
              : "Not requested in this link"
            : description;

          return (
            <li
              key={number}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "relative min-w-0 rounded-[12px] border px-2.5 py-3 transition-smooth sm:px-3 lg:flex lg:items-center lg:gap-3 lg:px-4 lg:py-3.5",
                isCurrent
                  ? "border-[var(--accent-gold)]/35 bg-[var(--accent-gold-dim)]"
                  : "border-transparent lg:border-[var(--border-subtle)]",
              )}
            >
              <span
                className={cn(
                  "mx-auto flex size-8 items-center justify-center rounded-full border text-[12px] font-semibold lg:mx-0 lg:size-9 lg:shrink-0",
                  isDone
                    ? "border-[var(--success-green)]/35 bg-[var(--success-green)]/10 text-[var(--success-green)]"
                    : isCurrent
                      ? "border-[var(--accent-gold)]/45 bg-[var(--bg-base)] text-[var(--accent-gold-strong)]"
                      : "border-[var(--border-strong)] bg-[var(--bg-base)] text-[var(--text-muted)]",
                )}
              >
                {isDone ? (
                  <Check className="size-4" aria-hidden />
                ) : (
                  <Icon className="size-4" aria-hidden />
                )}
              </span>
              <span className="mt-2 block min-w-0 text-center lg:mt-0 lg:text-left">
                <span
                  className={cn(
                    "block truncate text-[12px] font-semibold sm:text-[13px]",
                    isCurrent || isDone
                      ? "text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)]",
                  )}
                >
                  {label}
                </span>
                <span className="mt-0.5 hidden text-[11.5px] leading-snug text-[var(--text-muted)] lg:block">
                  {stepDescription}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      <div id={`${id}-error`} aria-live="polite">
        <FieldError>{error}</FieldError>
      </div>
    </div>
  );
}

function ConnectionNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-[12px] border border-[var(--accent-gold)]/20 bg-[var(--accent-gold-dim)] px-3.5 py-3.5 sm:px-4">
      <ShieldCheck
        className="mt-0.5 size-4 shrink-0 text-[var(--accent-gold-strong)]"
        aria-hidden
      />
      <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">{children}</p>
    </div>
  );
}

export function ClientOnboardingPreview({
  config,
}: {
  config: ClientOnboardingPreviewConfig;
}) {
  const [step, setStep] = React.useState<Step>(() =>
    config.mode === "new" ? 1 : firstAssetStep(config),
  );
  const [complete, setComplete] = React.useState(false);
  const [account, setAccount] = React.useState<AccountFields>({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [accountErrors, setAccountErrors] = React.useState<AccountErrors>({});
  const [stores, setStores] = React.useState<PreviewStore[]>([]);
  const [storeError, setStoreError] = React.useState("");
  const [adAccounts, setAdAccounts] = React.useState<PreviewAdAccount[]>([]);
  const [adsError, setAdsError] = React.useState("");
  const [isSimulatingWindsor, setIsSimulatingWindsor] = React.useState(false);
  const [liveMessage, setLiveMessage] = React.useState("");
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const storeSequence = React.useRef(0);
  const adsSequence = React.useRef(0);
  const windsorTimer = React.useRef<number | null>(null);
  const hasMounted = React.useRef(false);

  React.useEffect(() => {
    // A future invitation may place a bearer in the fragment. This preview
    // never reads, stores or displays its value, and clears the complete
    // fragment before the user starts interacting.
    if (window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }

    return () => {
      if (windsorTimer.current) window.clearTimeout(windsorTimer.current);
    };
  }, []);

  React.useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }

    const frame = window.requestAnimationFrame(() => headingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [step, complete]);

  function updateAccount<Key extends keyof AccountFields>(key: Key, value: AccountFields[Key]) {
    setAccount((current) => ({ ...current, [key]: value }));
    setAccountErrors((current) => ({ ...current, [key]: undefined }));
  }

  function continueFromAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = validateAccount(account);
    setAccountErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setStep(2);
  }

  function addPreviewStore() {
    const fixtureIndex = storeSequence.current % STORE_FIXTURES.length;
    const iteration = Math.floor(storeSequence.current / STORE_FIXTURES.length);
    const fixture = STORE_FIXTURES[fixtureIndex];
    const suffix = iteration > 0 ? ` ${iteration + 1}` : "";
    const id = `preview-store-${storeSequence.current + 1}`;
    storeSequence.current += 1;

    setStores((current) => [
      ...current,
      {
        id,
        name: `${fixture.name}${suffix}`,
        domain: fixture.domain.replace(".myshopify.com", `${iteration || ""}.myshopify.com`),
      },
    ]);
    setStoreError("");
    setLiveMessage("A preview store was added. No Shopify connection was created.");
  }

  function removeStore(id: string) {
    setStores((current) => current.filter((store) => store.id !== id));
    setAdAccounts((current) =>
      current.map((accountItem) =>
        accountItem.storeId === id ? { ...accountItem, storeId: "" } : accountItem,
      ),
    );
    setLiveMessage("The draft store was removed from this preview.");
  }

  function continueFromStores() {
    if (stores.length === 0) {
      setStoreError("Add at least one preview store to continue.");
      return;
    }
    if (requestsGoogle(config.assets)) {
      setStep(3);
    } else {
      setComplete(true);
    }
  }

  function addAdAccountFixtures(count: number) {
    const existingCustomerIds = new Set(adAccounts.map((accountItem) => accountItem.customerId));
    const availableFixtures = AD_ACCOUNT_FIXTURES.filter(
      (fixture) => !existingCustomerIds.has(fixture.customerId),
    ).slice(0, count);
    const additions = availableFixtures.map((fixture) => {
      const sequence = adsSequence.current + 1;
      adsSequence.current += 1;
      return {
        id: `preview-ad-account-${sequence}`,
        name: fixture.name,
        customerId: fixture.customerId,
        storeId: "",
      } satisfies PreviewAdAccount;
    });

    if (additions.length === 0) {
      setLiveMessage("All available preview Google Ads accounts are already selected.");
      return;
    }

    setAdAccounts((current) => [...current, ...additions]);
    setAdsError("");
    setLiveMessage(
      `${additions.length} preview Google Ads ${
        additions.length === 1 ? "account was" : "accounts were"
      } selected. No Windsor connection was created.`,
    );
  }

  function simulateWindsorSelection() {
    if (isSimulatingWindsor) return;
    setAdsError("");
    setIsSimulatingWindsor(true);
    setLiveMessage("Simulating a redirect to Windsor…");
    windsorTimer.current = window.setTimeout(() => {
      addAdAccountFixtures(2);
      setIsSimulatingWindsor(false);
      windsorTimer.current = null;
    }, 650);
  }

  function removeAdAccount(id: string) {
    setAdAccounts((current) => current.filter((accountItem) => accountItem.id !== id));
    setLiveMessage("The preview Google Ads account was removed.");
  }

  function mapAccountToStore(accountId: string, storeId: string) {
    setAdAccounts((current) =>
      current.map((accountItem) =>
        accountItem.id === accountId ? { ...accountItem, storeId } : accountItem,
      ),
    );
  }

  function finishPreview() {
    if (adAccounts.length === 0) {
      setAdsError("Select at least one preview Google Ads account to finish.");
      return;
    }
    setComplete(true);
  }

  function goBack() {
    if (windsorTimer.current) {
      window.clearTimeout(windsorTimer.current);
      windsorTimer.current = null;
      setIsSimulatingWindsor(false);
    }
    if (complete) {
      setComplete(false);
      return;
    }
    if (step === 3 && requestsShopify(config.assets)) {
      setStep(2);
    } else if (step === 2 && config.mode === "new") {
      setStep(1);
    }
  }

  const canGoBack =
    complete ||
    (step === 3 && requestsShopify(config.assets)) ||
    (step === 2 && config.mode === "new");

  const contextLabel =
    config.mode === "new"
      ? "New client onboarding"
      : config.mode === "reconnect"
        ? "Existing client reconnection"
        : `Add ${
            config.assets === "both"
              ? "Shopify + Google Ads"
              : config.assets === "shopify"
                ? "Shopify"
                : "Google Ads"
          }`;

  const heading = complete
    ? "Your setup is ready for review"
    : step === 1
      ? "Create your Dropscale account"
      : step === 2
        ? "Add your Shopify stores"
        : "Connect your Google Ads accounts";

  return (
    <main className="min-h-svh bg-[var(--bg-base)] px-4 py-5 sm:px-6 sm:py-8 lg:py-10">
      <div className="mx-auto w-full max-w-6xl">
        <header className="flex items-center justify-between gap-4 px-1">
          <Logo size="lg" />
          <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
            <LockKeyhole className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Secure client setup</span>
          </div>
        </header>

        <div
          className="mt-5 flex items-start gap-3 rounded-[12px] border border-[var(--warning-orange)]/25 bg-[var(--warning-orange)]/8 px-3.5 py-3 sm:mt-6 sm:px-4"
          role="status"
        >
          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-[var(--warning-orange)]" />
          <p className="text-[12.5px] leading-relaxed text-[#d7a67f]">
            <strong className="font-semibold text-[#e8b58c]">Local product preview</strong>
            {" — "}no account or connection is created.
          </p>
        </div>

        <div className="mt-5 grid gap-5 lg:mt-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start lg:gap-6">
          <aside className="lg:sticky lg:top-8">
            <div className="mb-3 hidden px-1 lg:block">
              <p className="label-caps">Client onboarding</p>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                Account, commerce data and advertising access in one guided flow.
              </p>
            </div>
            <Stepper step={step} complete={complete} config={config} />

            <div className="mt-4 hidden rounded-[12px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-4 lg:block">
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--text-primary)]">
                <ShieldCheck className="size-4 text-[var(--success-green)]" aria-hidden />
                Connections stay separate
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                Shopify reporting access is handled by Dropscale. Google Ads selection is handled
                through Windsor.
              </p>
            </div>
          </aside>

          <section
            className="overflow-hidden rounded-[var(--radius-window)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] shadow-[0_24px_70px_rgba(0,0,0,0.25)]"
            aria-labelledby="onboarding-heading"
          >
            <div className="border-b border-[var(--border-subtle)] px-5 py-5 sm:px-7 sm:py-6">
              <p className="label-caps">
                {complete
                  ? "Preview complete"
                  : `${contextLabel} · Step ${step} of ${STEPS.length}`}
              </p>
              <h1
                ref={headingRef}
                id="onboarding-heading"
                tabIndex={-1}
                className="mt-1.5 text-[21px] leading-tight font-semibold tracking-tight text-[var(--text-primary)] outline-none sm:text-[24px]"
              >
                {heading}
              </h1>
              <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--text-secondary)]">
                {complete
                  ? "Here is what would be sent to the Dropscale team after the live connection flow."
                  : step === 1
                    ? "Set up the credentials you would use to enter your performance dashboard."
                    : step === 2
                      ? "Connect every store you want Dropscale to include in performance reporting."
                      : "Choose the advertising accounts that belong in your Dropscale workspace."}
              </p>
            </div>

            <div className="px-5 py-5 sm:px-7 sm:py-6">
              {step === 1 && !complete && (
                <form id="account-preview-form" onSubmit={continueFromAccount} noValidate>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field id="preview-first-name" label="First name" error={accountErrors.firstName}>
                      <Input
                        id="preview-first-name"
                        name="firstName"
                        autoComplete="given-name"
                        value={account.firstName}
                        onChange={(event) => updateAccount("firstName", event.target.value)}
                        aria-invalid={Boolean(accountErrors.firstName)}
                        aria-describedby={accountErrors.firstName ? "preview-first-name-error" : undefined}
                        placeholder="First name"
                      />
                    </Field>
                    <Field id="preview-last-name" label="Last name" error={accountErrors.lastName}>
                      <Input
                        id="preview-last-name"
                        name="lastName"
                        autoComplete="family-name"
                        value={account.lastName}
                        onChange={(event) => updateAccount("lastName", event.target.value)}
                        aria-invalid={Boolean(accountErrors.lastName)}
                        aria-describedby={accountErrors.lastName ? "preview-last-name-error" : undefined}
                        placeholder="Last name"
                      />
                    </Field>
                    <div className="sm:col-span-2">
                      <Field id="preview-email" label="Email address" error={accountErrors.email}>
                        <Input
                          id="preview-email"
                          name="email"
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          value={account.email}
                          onChange={(event) => updateAccount("email", event.target.value)}
                          aria-invalid={Boolean(accountErrors.email)}
                          aria-describedby={accountErrors.email ? "preview-email-error" : undefined}
                          placeholder="you@company.com"
                        />
                      </Field>
                    </div>
                    <Field id="preview-password" label="Password" error={accountErrors.password}>
                      <PasswordInput
                        id="preview-password"
                        name="password"
                        autoComplete="new-password"
                        value={account.password}
                        onChange={(event) => updateAccount("password", event.target.value)}
                        aria-invalid={Boolean(accountErrors.password)}
                        aria-describedby={accountErrors.password ? "preview-password-error" : undefined}
                        placeholder="At least 8 characters"
                      />
                    </Field>
                    <Field
                      id="preview-confirm-password"
                      label="Confirm password"
                      error={accountErrors.confirmPassword}
                    >
                      <PasswordInput
                        id="preview-confirm-password"
                        name="confirmPassword"
                        autoComplete="new-password"
                        value={account.confirmPassword}
                        onChange={(event) => updateAccount("confirmPassword", event.target.value)}
                        aria-invalid={Boolean(accountErrors.confirmPassword)}
                        aria-describedby={
                          accountErrors.confirmPassword ? "preview-confirm-password-error" : undefined
                        }
                        placeholder="Repeat your password"
                      />
                    </Field>
                  </div>

                  <p className="mt-4 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                    Preview data only. These details stay in this browser tab and are discarded when
                    you leave or refresh.
                  </p>
                </form>
              )}

              {step === 2 && !complete && (
                <div>
                  <ConnectionNote>
                    The live version will use a secure Dropscale performance connection with
                    read-only reporting scopes. Shopify access is handled directly by Dropscale,
                    not Windsor, and is limited to the data needed for performance reports.
                  </ConnectionNote>

                  <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                        Your stores
                      </p>
                      <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                        Add one or several Shopify stores to this workspace.
                      </p>
                    </div>
                    <Button type="button" variant="secondary" size="sm" onClick={addPreviewStore}>
                      <Plus aria-hidden />
                      {stores.length === 0 ? "Add preview store" : "Add another"}
                    </Button>
                  </div>

                  {stores.length === 0 ? (
                    <button
                      type="button"
                      onClick={addPreviewStore}
                      className="mt-4 flex min-h-40 w-full flex-col items-center justify-center rounded-[14px] border border-dashed border-[var(--border-strong)] bg-[var(--bg-base)] px-5 py-8 text-center transition-smooth hover:border-[var(--accent-gold)]/35 hover:bg-[var(--accent-gold-dim)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/35"
                    >
                      <span className="flex size-10 items-center justify-center rounded-full bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]">
                        <Store className="size-5" aria-hidden />
                      </span>
                      <span className="mt-3 text-[13px] font-semibold text-[var(--text-primary)]">
                        Add your first preview store
                      </span>
                      <span className="mt-1 max-w-sm text-[12px] leading-relaxed text-[var(--text-muted)]">
                        This simulates the result of a secure connection without contacting Shopify.
                      </span>
                    </button>
                  ) : (
                    <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                      {stores.map((store) => (
                        <li
                          key={store.id}
                          className="rounded-[13px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]">
                              <ShoppingBag className="size-4" aria-hidden />
                            </span>
                            <span className="rounded-full border border-[var(--warning-orange)]/25 bg-[var(--warning-orange)]/8 px-2 py-1 text-[10px] font-semibold tracking-wide text-[#dba171] uppercase">
                              Preview store
                            </span>
                          </div>
                          <p className="mt-3 truncate text-[13px] font-semibold text-[var(--text-primary)]">
                            {store.name}
                          </p>
                          <p className="mt-1 truncate text-[11.5px] text-[var(--text-muted)]">
                            {store.domain}
                          </p>
                          <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3">
                            <span className="text-[11px] text-[var(--text-muted)]">Draft connection</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => removeStore(store.id)}
                              aria-label={`Remove ${store.name} draft`}
                              title="Remove draft"
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  {storeError && (
                    <p className="mt-3 text-[12px] text-[var(--danger-red)]" role="alert">
                      {storeError}
                    </p>
                  )}
                </div>
              )}

              {step === 3 && !complete && (
                <div>
                  <ConnectionNote>
                    Windsor opens Google&apos;s consent screen, then returns the accounts available to
                    that Google login. You choose what Dropscale can use for reporting; the preview
                    below makes no Windsor or Google request.
                  </ConnectionNote>

                  <div className="mt-5 rounded-[14px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4 sm:flex sm:items-center sm:justify-between sm:gap-5 sm:p-5">
                    <div className="flex items-start gap-3">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-[#4285f4]/10 text-[#7cafff]">
                        <Link2 className="size-5" aria-hidden />
                      </span>
                      <div>
                        <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                          Select accounts with Windsor
                        </p>
                        <p className="mt-1 max-w-md text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                          Simulates the redirect, Google login and account selection, then returns two
                          demo accounts.
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="primary"
                      size="md"
                      className="mt-4 w-full sm:mt-0 sm:w-auto sm:shrink-0"
                      loading={isSimulatingWindsor}
                      disabled={adAccounts.length >= AD_ACCOUNT_FIXTURES.length}
                      onClick={simulateWindsorSelection}
                    >
                      {adAccounts.length === 0
                        ? "Continue with Windsor"
                        : adAccounts.length >= AD_ACCOUNT_FIXTURES.length
                          ? "All preview accounts selected"
                          : "Use another Google login"}
                      {!isSimulatingWindsor && <ExternalLink aria-hidden />}
                    </Button>
                  </div>

                  {adAccounts.length > 0 && (
                    <div className="mt-5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                            Selected ad accounts
                          </p>
                          <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                            Optionally match each account to one of your stores.
                          </p>
                        </div>
                        <span className="rounded-full border border-[var(--success-green)]/25 bg-[var(--success-green)]/10 px-2.5 py-1 text-[11px] font-medium text-[var(--success-green)]">
                          {adAccounts.length} selected
                        </span>
                      </div>

                      <ul className="mt-3 space-y-3">
                        {adAccounts.map((accountItem) => (
                          <li
                            key={accountItem.id}
                            className="rounded-[13px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <CheckCircle2
                                    className="size-4 shrink-0 text-[var(--success-green)]"
                                    aria-hidden
                                  />
                                  <p className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
                                    {accountItem.name}
                                  </p>
                                </div>
                                <p className="mt-1 pl-6 text-[11.5px] text-[var(--text-muted)]">
                                  Customer ID {accountItem.customerId} · Preview account
                                </p>
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => removeAdAccount(accountItem.id)}
                                aria-label={`Remove ${accountItem.name}`}
                                title="Remove preview account"
                              >
                                <Trash2 aria-hidden />
                              </Button>
                            </div>

                            {stores.length > 0 ? (
                              <div className="mt-3 border-t border-[var(--border-subtle)] pt-3">
                                <Label htmlFor={`${accountItem.id}-store`}>
                                  Match to store (optional)
                                </Label>
                                <select
                                  id={`${accountItem.id}-store`}
                                  value={accountItem.storeId}
                                  onChange={(event) =>
                                    mapAccountToStore(accountItem.id, event.target.value)
                                  }
                                  className="mt-1.5 h-10 w-full appearance-none rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-3 text-[13px] text-[var(--text-primary)] transition-smooth hover:border-[var(--border-strong)] focus-visible:border-[var(--accent-gold)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/15"
                                >
                                  <option value="">No store selected</option>
                                  {stores.map((store) => (
                                    <option key={store.id} value={store.id}>
                                      {store.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ) : (
                              <p className="mt-3 border-t border-[var(--border-subtle)] pt-3 text-[11px] text-[var(--text-muted)]">
                                Store mapping can be completed by the Dropscale team later.
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {adsError && (
                    <p className="mt-3 text-[12px] text-[var(--danger-red)]" role="alert">
                      {adsError}
                    </p>
                  )}
                </div>
              )}

              {complete && (
                <div>
                  <div className="flex items-start gap-3 rounded-[14px] border border-[var(--success-green)]/25 bg-[var(--success-green)]/8 p-4 sm:p-5">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--success-green)]/12 text-[var(--success-green)]">
                      <CheckCircle2 className="size-5" aria-hidden />
                    </span>
                    <div>
                      <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                        Preview onboarding completed
                      </p>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                        In the live flow, Dropscale would now review the account and connection
                        results before activating dashboard access.
                      </p>
                    </div>
                  </div>

                  <dl className="mt-5 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-[13px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
                      <dt className="label-caps">Account</dt>
                      <dd className="mt-2 truncate text-[13px] font-semibold text-[var(--text-primary)]">
                        {config.mode === "new"
                          ? `${account.firstName} ${account.lastName}`
                          : "Existing client profile"}
                      </dd>
                      <dd className="mt-1 truncate text-[11.5px] text-[var(--text-muted)]">
                        {config.mode === "new"
                          ? account.email
                          : "Identity and dashboard access preserved"}
                      </dd>
                    </div>
                    <div className="rounded-[13px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
                      <dt className="label-caps">Shopify</dt>
                      <dd className="mt-2 text-[22px] font-semibold tracking-tight text-[var(--accent-gold-strong)]">
                        {requestsShopify(config.assets) ? stores.length : "—"}
                      </dd>
                      <dd className="mt-1 text-[11.5px] text-[var(--text-muted)]">
                        {requestsShopify(config.assets)
                          ? stores.length === 1
                            ? "store included"
                            : "stores included"
                          : "not requested in this link"}
                      </dd>
                    </div>
                    <div className="rounded-[13px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
                      <dt className="label-caps">Google Ads</dt>
                      <dd className="mt-2 text-[22px] font-semibold tracking-tight text-[var(--accent-gold-strong)]">
                        {requestsGoogle(config.assets) ? adAccounts.length : "—"}
                      </dd>
                      <dd className="mt-1 text-[11.5px] text-[var(--text-muted)]">
                        {requestsGoogle(config.assets)
                          ? adAccounts.length === 1
                            ? "account included"
                            : "accounts included"
                          : "not requested in this link"}
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-5 rounded-[13px] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
                    <p className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                      What happens next in the live flow
                    </p>
                    <ul className="mt-3 space-y-2.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                      <li className="flex gap-2.5">
                        <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--success-green)]" aria-hidden />
                        The Dropscale team reviews the client and verifies each connection.
                      </li>
                      <li className="flex gap-2.5">
                        <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--success-green)]" aria-hidden />
                        Dashboard access is activated only after the admin review.
                      </li>
                      <li className="flex gap-2.5">
                        <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--success-green)]" aria-hidden />
                        Billing remains a separate admin process and is not started by onboarding.
                      </li>
                    </ul>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-[var(--border-subtle)] bg-[var(--bg-base)]/45 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
              <Button
                type="button"
                variant="ghost"
                size="md"
                onClick={goBack}
                disabled={!canGoBack}
                className="w-full sm:w-auto"
              >
                <ArrowLeft aria-hidden />
                Back
              </Button>

              {!complete && (
                <Button
                  type={step === 1 ? "submit" : "button"}
                  form={step === 1 ? "account-preview-form" : undefined}
                  variant="primary"
                  size="lg"
                  onClick={
                    step === 2 ? continueFromStores : step === 3 ? finishPreview : undefined
                  }
                  className="w-full sm:w-auto"
                >
                  {step === 3 || (step === 2 && !requestsGoogle(config.assets))
                    ? "Finish preview"
                    : "Continue"}
                  <ArrowRight aria-hidden />
                </Button>
              )}
            </div>
          </section>
        </div>

        <p className="mt-5 text-center text-[11px] leading-relaxed text-[var(--text-muted)]">
          Product preview only · Shopify, Windsor, Google and billing services are not contacted.
        </p>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {liveMessage}
        </span>
      </div>
    </main>
  );
}
