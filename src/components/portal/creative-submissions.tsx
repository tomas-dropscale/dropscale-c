"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Info, Trash2, Upload } from "lucide-react";

import type { CreativeSubmission, CreativeSubmissionStatus } from "@/lib/supabase/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/auth-card";
import { createClient } from "@/lib/supabase/client";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

/** http/https only — the same rule the database enforces (migration 0018). */
const LINK = /^https?:\/\/\S+$/i;

const TONE: Record<CreativeSubmissionStatus, "neutral" | "gold" | "danger"> = {
  new: "neutral",
  in_use: "gold",
  rejected: "danger",
};

/**
 * Handing creatives in, and seeing what the team did with them.
 *
 * A link rather than an upload, on purpose: the files are big videos that
 * already live in the client's own Drive, and this way there is no upload to
 * fail halfway and nothing for us to store or lose.
 *
 * Always rendered, whether or not Google Ads is connected — submitting work has
 * nothing to do with the reporting side of the page being wired up.
 */
export function CreativeSubmissions({
  accountId,
  submittedBy,
  submissions,
}: {
  accountId: string;
  /** The signed-in person, so a sócio's batch is attributed to them. */
  submittedBy: string;
  submissions: CreativeSubmission[];
}) {
  const router = useRouter();
  const { d, intl } = useI18n();

  const [title, setTitle] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [collectionUrl, setCollectionUrl] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [urlError, setUrlError] = React.useState<string | null>(null);
  const [collectionError, setCollectionError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const label: Record<CreativeSubmissionStatus, string> = {
    new: d.submissions.statusNew,
    in_use: d.submissions.statusInUse,
    rejected: d.submissions.statusRejected,
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setUrlError(null);
    setCollectionError(null);
    setError(null);
    setSent(false);

    if (!LINK.test(url.trim())) {
      setUrlError(d.submissions.urlInvalid);
      return;
    }
    if (!LINK.test(collectionUrl.trim())) {
      setCollectionError(d.submissions.urlInvalid);
      return;
    }

    setSaving(true);
    const { error: insertError } = await createClient().from("creative_submissions").insert({
      ad_account_id: accountId,
      submitted_by: submittedBy,
      title: title.trim(),
      url: url.trim(),
      collection_url: collectionUrl.trim(),
      notes: notes.trim() || null,
    });
    setSaving(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    setTitle("");
    setUrl("");
    setCollectionUrl("");
    setNotes("");
    setSent(true);
    router.refresh();
  }

  async function withdraw(submission: CreativeSubmission) {
    if (!window.confirm(fmt(d.submissions.removeConfirm, { name: submission.title }))) return;

    setBusyId(submission.id);
    setError(null);
    const { error: deleteError } = await createClient()
      .from("creative_submissions")
      .delete()
      .eq("id", submission.id);
    setBusyId(null);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    router.refresh();
  }

  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(intl, { day: "2-digit", month: "short", year: "numeric" });

  return (
    <section className="space-y-4">
      {error && <FormAlert>{error}</FormAlert>}
      {sent && <FormAlert tone="success">{d.submissions.sent}</FormAlert>}

      <div className="panel p-5">
        <header className="mb-1 flex items-center gap-2">
          <Upload size={17} strokeWidth={1.5} className="text-[var(--accent-gold)]" aria-hidden />
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
            {d.submissions.add}
          </h2>
        </header>
        <p className="mb-4 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          {d.submissions.subtitle}
        </p>

        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="creative-title">{d.submissions.nameLabel}</Label>
              <Input
                id="creative-title"
                placeholder={d.submissions.namePlaceholder}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="creative-url">{d.submissions.urlLabel}</Label>
              <Input
                id="creative-url"
                type="url"
                inputMode="url"
                placeholder={d.submissions.urlPlaceholder}
                aria-invalid={Boolean(urlError)}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
              <FieldError>{urlError}</FieldError>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="creative-collection">{d.submissions.collectionLabel}</Label>
            <Input
              id="creative-collection"
              type="url"
              inputMode="url"
              placeholder={d.submissions.collectionPlaceholder}
              aria-invalid={Boolean(collectionError)}
              value={collectionUrl}
              onChange={(event) => setCollectionUrl(event.target.value)}
            />
            <FieldError>{collectionError}</FieldError>
            <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
              {d.submissions.collectionHelp}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="creative-notes">{d.submissions.notesLabel}</Label>
            <textarea
              id="creative-notes"
              rows={3}
              placeholder={d.submissions.notesPlaceholder}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="transition-smooth w-full resize-y rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent-gold)]/50"
            />
          </div>

          <div className="flex items-start gap-2 rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
            <span>{d.submissions.accessHint}</span>
          </div>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={saving}
            disabled={!title.trim() || !url.trim() || !collectionUrl.trim()}
          >
            {d.submissions.send}
          </Button>
        </form>
      </div>

      <div className="panel p-5">
        <h2 className="mb-4 text-[15px] font-semibold text-[var(--text-primary)]">
          {d.submissions.title}
        </h2>

        {submissions.length === 0 ? (
          <p className="text-[12.5px] text-[var(--text-muted)]">{d.submissions.empty}</p>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)] rounded-[10px] border border-[var(--border-subtle)]">
            {submissions.map((submission) => (
              <li key={submission.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                    {submission.title}
                  </p>
                  <p className="text-[11.5px] text-[var(--text-muted)]">
                    {day(submission.created_at)}
                  </p>
                  {submission.collection_url && (
                    <a
                      href={submission.collection_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="transition-smooth mt-0.5 block truncate text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--accent-gold-strong)]"
                    >
                      {submission.collection_url}
                    </a>
                  )}
                  {submission.notes && (
                    <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                      {submission.notes}
                    </p>
                  )}
                  {/* Why it was turned down, in the client's own view — a
                      rejection with no reason just generates a question. */}
                  {submission.review_notes && (
                    <p className="mt-1 text-[12px] leading-relaxed text-[var(--accent-gold-strong)]">
                      {submission.review_notes}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={TONE[submission.status]}>{label[submission.status]}</Badge>

                  <a
                    href={submission.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={d.submissions.openLink}
                    className="transition-smooth rounded-md p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-panel-hover)] hover:text-[var(--text-primary)]"
                  >
                    <ExternalLink className="size-4" aria-hidden />
                  </a>

                  {/* Only while nobody has acted on it — matching the policy,
                      so the button is never there to be refused. */}
                  {submission.status === "new" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busyId === submission.id}
                      aria-label={d.submissions.remove}
                      onClick={() => void withdraw(submission)}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
