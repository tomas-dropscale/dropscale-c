"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  ExternalLink,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";

import { FormAlert } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { AUDIT_SHOPIFY_SCOPES_TEXT } from "@/lib/audit/shopify-scopes";

type Feedback = { tone: "error" | "success"; message: string } | null;
type LinkState = "checking" | "valid" | "invalid";
type ConnectedStore = { name: string; domain: string };

const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function ShopifyAuditOnboarding({ connectionId }: { connectionId: string }) {
  const [inviteToken, setInviteToken] = React.useState("");
  const [linkState, setLinkState] = React.useState<LinkState>("checking");
  const [linkError, setLinkError] = React.useState("");
  const [shopDomain, setShopDomain] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [feedback, setFeedback] = React.useState<Feedback>(null);
  const [scopeCopyError, setScopeCopyError] = React.useState("");
  const [connectedStore, setConnectedStore] = React.useState<ConnectedStore | null>(null);
  const currentToken = React.useRef("");
  const validationSequence = React.useRef(0);

  React.useEffect(() => {
    let controller: AbortController | null = null;

    const captureAndValidate = async () => {
      const fragment = window.location.hash.slice(1);
      const hasFragment = fragment.length > 0;
      const token = INVITE_TOKEN.test(fragment)
        ? fragment
        : !hasFragment
          ? currentToken.current
          : "";

      // Keep the bearer only in this component's memory, not in history, logs
      // or subsequent Referer values.
      if (hasFragment) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
      }

      currentToken.current = token;
      setInviteToken(token);
      setFeedback(null);
      if (!token) {
        setLinkState("invalid");
        setLinkError("This connection link is incomplete. Ask Dropscale for a new link.");
        return;
      }

      const sequence = ++validationSequence.current;
      controller?.abort();
      controller = new AbortController();
      setLinkState("checking");
      setLinkError("");

      try {
        const response = await fetch(`/api/audit/shopify/${connectionId}`, {
          method: "GET",
          cache: "no-store",
          headers: { "x-dropscale-audit-invite": token },
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        if (sequence !== validationSequence.current) return;
        if (!response.ok) {
          setLinkState("invalid");
          setLinkError(
            typeof body?.error === "string"
              ? body.error
              : "This connection link is no longer available. Ask Dropscale for a new link.",
          );
          return;
        }
        setLinkState("valid");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (sequence !== validationSequence.current) return;
        setLinkState("invalid");
        setLinkError("The secure link could not be checked. Check your internet, then reopen the original link.");
      }
    };

    void captureAndValidate();
    window.addEventListener("hashchange", captureAndValidate);
    return () => {
      controller?.abort();
      window.removeEventListener("hashchange", captureAndValidate);
    };
  }, [connectionId]);

  async function copyScopes() {
    setScopeCopyError("");
    try {
      await navigator.clipboard.writeText(AUDIT_SHOPIFY_SCOPES_TEXT);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setScopeCopyError("Could not copy the scopes. Select the text manually.");
    }
  }

  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (!INVITE_TOKEN.test(inviteToken)) {
      setFeedback({
        tone: "error",
        message: "This connection link is incomplete or no longer valid. Ask Dropscale for a new link.",
      });
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/audit/shopify/${connectionId}`, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken, shopDomain, clientId, clientSecret }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
        code?: unknown;
        missingScopes?: unknown;
        extraScopes?: unknown;
        store?: { name?: unknown; domain?: unknown };
      } | null;

      if (!response.ok) {
        const details = [body?.missingScopes, body?.extraScopes]
          .find(Array.isArray) as string[] | undefined;
        setFeedback({
          tone: "error",
          message:
            `${typeof body?.error === "string" ? body.error : "The store could not be connected."}` +
            (details?.length ? ` ${details.join(", ")}` : ""),
        });
        setClientSecret("");
        return;
      }

      if (
        typeof body?.store?.name !== "string" ||
        typeof body.store.domain !== "string"
      ) {
        setClientSecret("");
        setFeedback({
          tone: "error",
          message: "Shopify connected, but the verified store confirmation was incomplete.",
        });
        return;
      }

      currentToken.current = "";
      setInviteToken("");
      setClientSecret("");
      setConnectedStore({ name: body.store.name, domain: body.store.domain });
    } catch {
      setClientSecret("");
      setFeedback({
        tone: "error",
        message: "The connection could not be completed. Check your internet and try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = linkState === "valid" && INVITE_TOKEN.test(inviteToken);

  if (connectedStore) {
    return (
      <section className="panel mx-auto max-w-xl p-6 text-center sm:p-8">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-[var(--success-green)]/12 text-[var(--success-green)]">
          <CheckCircle2 className="size-6" aria-hidden />
        </span>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-[var(--text-primary)]">
          Store connected successfully
        </h1>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-[var(--text-secondary)]">
          Dropscale verified {connectedStore.name} ({connectedStore.domain}) and the complete audit
          permission profile. You can close this page; the team has been notified in Connections.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2 text-[12px] text-[var(--text-secondary)]">
          <ShieldCheck className="size-4 text-[var(--success-green)]" aria-hidden />
          The Client Secret is encrypted and the temporary Shopify token was not stored.
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="panel p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--accent-gold-dim)] text-[var(--accent-gold-strong)]">
            <ShieldCheck className="size-5" aria-hidden />
          </span>
          <div>
            <p className="label-caps">Dropscale audit connection</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--text-primary)]">
              Connect your Shopify store
            </h1>
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--text-secondary)]">
              This creates a connection for full store audits. The requested profile includes the
              complete set of permissions supplied by Dropscale, including sensitive read and write
              access.
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-start gap-3 rounded-[10px] border border-[var(--warning-orange)]/30 bg-[var(--warning-orange)]/8 px-3 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning-orange)]" aria-hidden />
          <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            Only continue if you are authorised to grant this access. These credentials can
            technically modify store data. This connection step verifies and encrypts them; it does
            not itself perform any Shopify mutation.
          </p>
        </div>
      </section>

      {linkState === "checking" ? (
        <section className="panel p-5 text-center sm:p-6" aria-live="polite">
          <p className="text-[13px] font-medium text-[var(--text-primary)]">
            Checking the secure connection link…
          </p>
          <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
            The Shopify setup steps will appear as soon as the invitation is confirmed.
          </p>
        </section>
      ) : linkState === "invalid" ? (
        <section className="panel p-5 sm:p-6" aria-live="polite">
          <FormAlert>{linkError}</FormAlert>
        </section>
      ) : (
        <>
          <section className="panel p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="label-caps">Setup guide</p>
            <h2 className="mt-1 text-[16px] font-semibold text-[var(--text-primary)]">
              Create and install the audit app
            </h2>
          </div>
          <Button asChild variant="secondary" size="sm">
            <Link href="https://dev.shopify.com/dashboard" target="_blank" rel="noreferrer">
              Open Shopify Dev Dashboard
              <ExternalLink aria-hidden />
            </Link>
          </Button>
        </div>

        <ol className="mt-5 space-y-4">
          {[
            <span key="one">
              In the Shopify Dev Dashboard, click
              <strong className="font-medium text-[var(--text-primary)]"> Create app</strong>, give it a
              name such as
              <strong className="font-medium text-[var(--text-primary)]"> Dropscale Audit</strong>, and
              continue.
            </span>,
            <span key="two">
              In the app setup, remove the
              <strong className="font-medium text-[var(--text-primary)]"> embedded app URL</strong>. Add
              exactly every scope shown below, then finish creating the app.
            </span>,
            <span key="three">
              Before installing, open
              <strong className="font-medium text-[var(--text-primary)]"> Settings</strong> and copy the
              <strong className="font-medium text-[var(--text-primary)]"> Client ID</strong> and
              <strong className="font-medium text-[var(--text-primary)]"> Client Secret</strong> somewhere
              secure. Do this first because installation redirects you out of the Dev Dashboard.
            </span>,
            <span key="four">
              Open <strong className="font-medium text-[var(--text-primary)]">Versions</strong>, click the
              latest version, then install the app on the correct store and confirm the installation.
            </span>,
            <span key="five">
              After Shopify confirms the installation, return here and enter the store&apos;s
              <strong className="font-medium text-[var(--text-primary)]"> .myshopify.com URL</strong>, the
              Client ID, and the Client Secret.
            </span>,
          ].map((content, index) => (
            <li key={index} className="flex gap-3 text-[13px] leading-relaxed text-[var(--text-secondary)]">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--bg-base)] text-[11px] font-semibold text-[var(--accent-gold-strong)]">
                {index + 1}
              </span>
              <span className="pt-0.5">{content}</span>
            </li>
          ))}
        </ol>

        <details className="mt-5 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-[13px] font-medium text-[var(--text-primary)]">
            Exact audit scopes
            <ChevronDown className="size-4 text-[var(--text-muted)]" aria-hidden />
          </summary>
          <div className="border-t border-[var(--border-subtle)] p-3">
            <code className="block break-all text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
              {AUDIT_SHOPIFY_SCOPES_TEXT}
            </code>
            <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={copyScopes}>
              {copied ? <Check aria-hidden /> : <Clipboard aria-hidden />}
              {copied ? "Copied" : "Copy scopes"}
            </Button>
            {scopeCopyError && (
              <p className="mt-2 text-[12px] text-[var(--danger-red)]" role="status">
                {scopeCopyError}
              </p>
            )}
          </div>
        </details>
          </section>

          <form onSubmit={connect} className="panel p-5 sm:p-6" autoComplete="off">
        <div>
          <p className="label-caps">Secure connection</p>
          <h2 className="mt-1 text-[16px] font-semibold text-[var(--text-primary)]">
            Verify the store and permissions
          </h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            The Client Secret is encrypted before storage. The temporary Shopify access token is not
            stored, and the complete permission profile is checked against Shopify&apos;s response.
          </p>
        </div>

        {feedback && (
          <div className="mt-4">
            <FormAlert tone={feedback.tone}>{feedback.message}</FormAlert>
          </div>
        )}

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="shop-domain">Shopify store domain</Label>
            <Input
              id="shop-domain"
              value={shopDomain}
              onChange={(event) => setShopDomain(event.target.value)}
              placeholder="your-store.myshopify.com"
              aria-describedby="shop-domain-help"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={255}
              required
            />
            <p
              id="shop-domain-help"
              className="text-[11.5px] leading-relaxed text-[var(--text-secondary)]"
            >
              Example: <code>your-store.myshopify.com</code> or
              <code className="ml-1">https://your-store.myshopify.com</code>. Use the permanent
              <code className="mx-1">.myshopify.com</code> address, not the public storefront
              domain.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="client-id">Client ID</Label>
            <Input
              id="client-id"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              placeholder="Paste the Client ID"
              autoCapitalize="none"
              spellCheck={false}
              minLength={8}
              maxLength={256}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="client-secret">Client Secret</Label>
            <Input
              id="client-secret"
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              placeholder="Paste the Client Secret"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              minLength={16}
              maxLength={512}
              required
            />
          </div>
        </div>

        <div className="mt-5 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2 text-[11.5px] text-[var(--text-secondary)]">
            <LockKeyhole className="size-3.5 text-[var(--success-green)]" aria-hidden />
            One-time link · encrypted credential
          </span>
          <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>
            Connect store
          </Button>
        </div>
          </form>
        </>
      )}
    </div>
  );
}
