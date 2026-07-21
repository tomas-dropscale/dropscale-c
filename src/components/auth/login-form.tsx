"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label, FieldError } from "@/components/ui/input";
import { PasswordInput } from "@/components/auth/password-input";
import { FormAlert } from "@/components/auth/auth-card";
import { GoogleButton } from "@/components/auth/google-button";
import { createClient } from "@/lib/supabase/client";
import { loginSchema, authErrorMessage, type LoginInput } from "@/lib/validations/auth";

const REMEMBERED_EMAIL_KEY = "dropscale-portal:remembered-email";

/** Internal paths only — blocks open redirect via ?next=https://evil.example */
function safeRedirect(next: string | null) {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/dashboard";
  return next;
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [serverError, setServerError] = React.useState<string | null>(null);

  const notice = searchParams.get("notice");
  const linkError = searchParams.get("error");

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "", remember: true },
  });

  // Prefill the email saved on the previous sign-in
  React.useEffect(() => {
    const saved = window.localStorage.getItem(REMEMBERED_EMAIL_KEY);
    if (saved) setValue("email", saved);
  }, [setValue]);

  /**
   * Recover a session whose access token expired while the tab was closed.
   *
   * With no proxy there is nothing to refresh the token server-side, so the
   * server sees a stale cookie and lands the user here. The refresh token is
   * usually still valid though: asking the browser client for the user makes
   * supabase-js mint a new access token and write it back to the cookies, at
   * which point the server will accept the session.
   */
  React.useEffect(() => {
    // Skip when the user just signed out, otherwise we would bounce them
    // straight back into the app they meant to leave.
    if (notice) return;

    let active = true;

    void Promise.resolve()
      .then(() => createClient().auth.getUser())
      .then(({ data }) => {
        if (!active || !data.user) return;
        router.replace(safeRedirect(searchParams.get("next")));
        router.refresh();
      })
      .catch(() => {
        // No session, or Supabase not configured — leave the form alone.
      });

    return () => {
      active = false;
    };
  }, [notice, router, searchParams]);

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);

    try {
      const supabase = createClient();

      const { error } = await supabase.auth.signInWithPassword({
        email: values.email.trim(),
        password: values.password,
      });

      if (error) {
        setServerError(authErrorMessage(error));
        return;
      }

      if (values.remember) {
        window.localStorage.setItem(REMEMBERED_EMAIL_KEY, values.email.trim());
      } else {
        window.localStorage.removeItem(REMEMBERED_EMAIL_KEY);
      }

      // refresh() revalidates Server Components with the new session first
      router.replace(safeRedirect(searchParams.get("next")));
      router.refresh();
    } catch (cause) {
      setServerError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {notice === "password-updated" && (
        <FormAlert tone="success">Password updated. Sign in with your new password.</FormAlert>
      )}
      {notice === "signed-out" && <FormAlert tone="success">You have been signed out.</FormAlert>}
      {notice === "access-revoked" && (
        <FormAlert>Your access level changed and this session was closed. Sign in again.</FormAlert>
      )}
      {(serverError ?? linkError) && <FormAlert>{serverError ?? linkError}</FormAlert>}

      <GoogleButton onError={setServerError} />

      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          aria-invalid={Boolean(errors.email)}
          {...register("email")}
        />
        <FieldError>{errors.email?.message}</FieldError>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Link
            href="/forgot-password"
            className="text-[12px] text-[var(--text-secondary)] transition-smooth hover:text-[var(--accent-gold)]"
          >
            Forgot password?
          </Link>
        </div>
        <PasswordInput
          id="password"
          autoComplete="current-password"
          placeholder="••••••••"
          aria-invalid={Boolean(errors.password)}
          {...register("password")}
        />
        <FieldError>{errors.password?.message}</FieldError>
      </div>

      <label className="flex w-fit cursor-pointer items-center gap-2 pt-1 text-[13px] text-[var(--text-secondary)]">
        <Checkbox
          defaultChecked
          onCheckedChange={(checked) => setValue("remember", checked === true)}
        />
        Remember me
      </label>

      <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting}>
        Sign in
        {!isSubmitting && <ArrowRight />}
      </Button>
    </form>
  );
}
