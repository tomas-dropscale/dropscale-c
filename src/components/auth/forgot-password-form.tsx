"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { FormAlert } from "@/components/auth/auth-card";
import { createClient } from "@/lib/supabase/client";
import { authRedirect } from "@/lib/site";
import {
  forgotPasswordSchema,
  authErrorMessage,
  type ForgotPasswordInput,
} from "@/lib/validations/auth";

export function ForgotPasswordForm() {
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);

    try {
      const supabase = createClient();

      const { error } = await supabase.auth.resetPasswordForEmail(values.email.trim(), {
        redirectTo: authRedirect("/reset-password"),
      });

      if (error) {
        setServerError(authErrorMessage(error));
        return;
      }

      setSent(true);
    } catch (cause) {
      setServerError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    }
  });

  if (sent) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-[var(--accent-gold-dim)]">
          <MailCheck className="size-5 text-[var(--accent-gold)]" />
        </div>
        <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
          If an account exists for that email, a reset link is on its way. Check your inbox.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {serverError && <FormAlert>{serverError}</FormAlert>}

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

      <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting}>
        Send reset link
      </Button>
    </form>
  );
}
