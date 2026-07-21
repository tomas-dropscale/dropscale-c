"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ExternalLink, Info } from "lucide-react";

import type { RequestType } from "@/lib/supabase/types";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/auth-card";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

/**
 * "Request Account" — the client asks the team to provision a new Google Ads
 * account or connect a Shopify store. Writes a pending account_requests row;
 * approval happens on the team's side.
 */
export function RequestAccountPanel({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [mode, setMode] = React.useState<RequestType>("google_ads");
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const [customerId, setCustomerId] = React.useState("");
  const [storeName, setStoreName] = React.useState("");
  const [collabCode, setCollabCode] = React.useState("");
  const [shopifyUrl, setShopifyUrl] = React.useState("");

  const complete =
    mode === "google_ads"
      ? customerId.trim() !== "" && storeName.trim() !== ""
      : collabCode.trim() !== "" && shopifyUrl.trim() !== "";

  async function submit() {
    setSubmitting(true);
    setServerError(null);

    const { error } = await createClient()
      .from("account_requests")
      .insert(
        mode === "google_ads"
          ? {
              client_id: clientId,
              request_type: "google_ads" as const,
              google_ads_customer_id: customerId.trim(),
              store_name: storeName.trim(),
            }
          : {
              client_id: clientId,
              request_type: "shopify" as const,
              shopify_collaborator_code: collabCode.trim(),
              myshopify_url: shopifyUrl.trim(),
            },
      );

    setSubmitting(false);

    if (error) {
      setServerError(error.message);
      return;
    }

    setSubmitted(true);
    router.refresh();
  }

  if (submitted) {
    return (
      <div className="panel mx-auto max-w-[560px] p-8 text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full bg-[var(--success-green)]/12">
          <CheckCircle2 className="size-5 text-[var(--success-green)]" />
        </div>
        <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">
          Request submitted
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          The team will review it and set the account up for you. You&apos;ll see it appear
          in your sidebar once it&apos;s approved.
        </p>
        <Button
          variant="secondary"
          className="mt-6"
          onClick={() => {
            setSubmitted(false);
            setCustomerId("");
            setStoreName("");
            setCollabCode("");
            setShopifyUrl("");
          }}
        >
          Submit another request
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[560px] space-y-5">
      {/* Segmented toggle */}
      <div className="flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-1">
        {(
          [
            ["google_ads", "Google Ads"],
            ["shopify", "Shopify"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={cn(
              "transition-smooth flex-1 rounded-full px-4 py-1.5 text-[13px] font-medium",
              mode === value
                ? "bg-[var(--accent-gold)] text-[#1a1409]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Info box */}
      <div className="panel flex items-start gap-3 p-4">
        <Info className="mt-0.5 size-4 shrink-0 text-[var(--accent-gold)]" />
        <div className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {mode === "google_ads" ? (
            <>
              Send us your Google Ads Customer ID and we&apos;ll link the account to your
              portal. You can find the ID in the top-right corner of your Google Ads
              interface.
            </>
          ) : (
            <>
              Generate a collaborator code in your Shopify admin (Settings → Users and
              permissions) and paste it below together with your store URL.
            </>
          )}{" "}
          <a
            href="#"
            className="transition-smooth inline-flex items-center gap-1 text-[var(--accent-gold)] hover:text-[var(--accent-gold-strong)]"
          >
            Watch tutorial
            <ExternalLink className="size-3" />
          </a>
        </div>
      </div>

      {serverError && <FormAlert>{serverError}</FormAlert>}

      {/* Fields */}
      <div className="panel space-y-4 p-5">
        {mode === "google_ads" ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="customerId">Google Ads Customer ID</Label>
              <Input
                id="customerId"
                placeholder="e.g. 123-456-7890"
                value={customerId}
                onChange={(event) => setCustomerId(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="storeName">Store Name</Label>
              <Input
                id="storeName"
                placeholder="e.g. My Store"
                value={storeName}
                onChange={(event) => setStoreName(event.target.value)}
              />
            </div>
          </>
        ) : (
          <>
            <p className="label-caps">Shopify</p>
            <div className="space-y-1.5">
              <Label htmlFor="collabCode">Shopify Collaborator Code</Label>
              <Input
                id="collabCode"
                placeholder="e.g. 1234"
                value={collabCode}
                onChange={(event) => setCollabCode(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shopifyUrl">.myshopify.com URL</Label>
              <Input
                id="shopifyUrl"
                placeholder="e.g. my-store.myshopify.com"
                value={shopifyUrl}
                onChange={(event) => setShopifyUrl(event.target.value)}
              />
            </div>
          </>
        )}
      </div>

      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={!complete}
        loading={submitting}
        onClick={submit}
      >
        Submit Request
      </Button>
    </div>
  );
}
