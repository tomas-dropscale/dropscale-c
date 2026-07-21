"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Button } from "@/components/ui/button";
import { Label, FieldError } from "@/components/ui/input";
import { PasswordInput } from "@/components/auth/password-input";
import { FormAlert } from "@/components/auth/auth-card";
import { createClient } from "@/lib/supabase/client";
import {
  resetPasswordSchema,
  authErrorMessage,
  type ResetPasswordInput,
} from "@/lib/validations/auth";

type Status = "checking" | "ready" | "no-session";

export function ResetPasswordForm() {
  const router = useRouter();
  const [status, setStatus] = React.useState<Status>("checking");
  const [serverError, setServerError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  /**
   * The reset link lands on /auth/callback, which exchanges the code for a
   * session. Here we only confirm that session exists before letting the user
   * write a new password.
   */
  React.useEffect(() => {
    let active = true;

    // createClient() is called inside then() on purpose: if the Supabase env
    // vars are missing, the throw becomes a rejection caught below instead of
    // blowing up synchronously in the effect body.
    void Promise.resolve()
      .then(() => createClient().auth.getUser())
      .then(({ data }) => {
        if (active) setStatus(data.user ? "ready" : "no-session");
      })
      .catch(() => {
        if (active) setStatus("no-session");
      });

    return () => {
      active = false;
    };
  }, []);

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password: values.password });

      if (error) {
        setServerError(authErrorMessage(error));
        return;
      }

      // Drop the temporary link session so the new password is actually used
      await supabase.auth.signOut();
      router.replace("/login?notice=password-updated");
      router.refresh();
    } catch (cause) {
      setServerError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    }
  });

  if (status === "checking") {
    return (
      <div className="space-y-3" aria-busy>
        <div className="h-10 animate-pulse rounded-[10px] bg-[var(--bg-panel-hover)]" />
        <div className="h-10 animate-pulse rounded-[10px] bg-[var(--bg-panel-hover)]" />
      </div>
    );
  }

  if (status === "no-session") {
    return (
      <div className="space-y-4">
        <FormAlert>
          This reset link is invalid or has expired. Request a new one below.
        </FormAlert>
        <Button asChild variant="secondary" size="lg" className="w-full">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {serverError && <FormAlert>{serverError}</FormAlert>}

      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <PasswordInput
          id="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          aria-invalid={Boolean(errors.password)}
          {...register("password")}
        />
        <FieldError>{errors.password?.message}</FieldError>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <PasswordInput
          id="confirmPassword"
          autoComplete="new-password"
          placeholder="Repeat the password"
          aria-invalid={Boolean(errors.confirmPassword)}
          {...register("confirmPassword")}
        />
        <FieldError>{errors.confirmPassword?.message}</FieldError>
      </div>

      <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting}>
        Update password
      </Button>
    </form>
  );
}
