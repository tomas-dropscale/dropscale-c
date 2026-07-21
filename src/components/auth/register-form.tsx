"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, MailCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { PasswordInput } from "@/components/auth/password-input";
import { FormAlert } from "@/components/auth/auth-card";
import { GoogleButton } from "@/components/auth/google-button";
import { createClient } from "@/lib/supabase/client";
import { authRedirect } from "@/lib/site";
import { useI18n } from "@/lib/i18n/provider";
import { registerSchema, authErrorMessage, type RegisterInput } from "@/lib/validations/auth-i18n";

export function RegisterForm() {
  const router = useRouter();
  const { d } = useI18n();
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [needsConfirmation, setNeedsConfirmation] = React.useState(false);

  const schema = React.useMemo(() => registerSchema(d), [d]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({
    resolver: zodResolver(schema),
    defaultValues: { fullName: "", email: "", password: "", confirmPassword: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);

    try {
      const supabase = createClient();

      const { data, error } = await supabase.auth.signUp({
        email: values.email.trim(),
        password: values.password,
        options: {
          // full_name is read by the admin app's handle_new_user() trigger for
          // public.profiles, and by handle_new_portal_client() (migration
          // 0002) for public.portal_clients. portal_signup is what tells the
          // second trigger this is a client registering, not a staff member
          // signing up in the admin app against the same Supabase project.
          //
          // Both flags are browser-supplied and neither grants anything: the
          // trigger hard-codes approval_status 'pending', and the role comes
          // from the database.
          data: { full_name: values.fullName.trim(), portal_signup: "true" },
          // Not /dashboard: that route's gate would show the same waiting
          // screen, but /confirmed can also say the confirmation worked.
          emailRedirectTo: authRedirect("/confirmed"),
        },
      });

      if (error) {
        setServerError(authErrorMessage(error, d));
        return;
      }

      // No session returned ⇒ the project requires email confirmation
      if (!data.session) {
        setNeedsConfirmation(true);
        return;
      }

      // Lands on the awaiting-approval screen until the team approves them.
      router.replace("/dashboard");
      router.refresh();
    } catch (cause) {
      setServerError(cause instanceof Error ? cause.message : d.auth.register.unexpected);
    }
  });

  if (needsConfirmation) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-[var(--accent-gold-dim)]">
          <MailCheck className="size-5 text-[var(--accent-gold)]" />
        </div>
        <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {d.auth.register.checkInbox}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {serverError && <FormAlert>{serverError}</FormAlert>}

      <GoogleButton onError={setServerError} />

      <div className="space-y-1.5">
        <Label htmlFor="fullName">{d.auth.register.nameLabel}</Label>
        <Input
          id="fullName"
          autoComplete="name"
          placeholder={d.auth.register.namePlaceholder}
          aria-invalid={Boolean(errors.fullName)}
          {...register("fullName")}
        />
        <FieldError>{errors.fullName?.message}</FieldError>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">{d.auth.emailLabel}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder={d.auth.emailPlaceholder}
          aria-invalid={Boolean(errors.email)}
          {...register("email")}
        />
        <FieldError>{errors.email?.message}</FieldError>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">{d.auth.passwordLabel}</Label>
        <PasswordInput
          id="password"
          autoComplete="new-password"
          placeholder={d.auth.register.passwordPlaceholder}
          aria-invalid={Boolean(errors.password)}
          {...register("password")}
        />
        <FieldError>{errors.password?.message}</FieldError>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirmPassword">{d.auth.register.confirmLabel}</Label>
        <PasswordInput
          id="confirmPassword"
          autoComplete="new-password"
          placeholder={d.auth.register.confirmPlaceholder}
          aria-invalid={Boolean(errors.confirmPassword)}
          {...register("confirmPassword")}
        />
        <FieldError>{errors.confirmPassword?.message}</FieldError>
      </div>

      <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting}>
        {d.auth.register.submit}
        {!isSubmitting && <ArrowRight />}
      </Button>
    </form>
  );
}
