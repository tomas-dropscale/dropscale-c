import { z } from "zod";
import type { Dictionary } from "@/lib/i18n";

/**
 * Schemas are built per-locale so validation messages are translated too.
 * `useMemo(() => loginSchema(d), [d])` in the forms keeps them stable.
 */
export function loginSchema(d: Dictionary) {
  return z.object({
    email: z.email({ message: d.auth.validation.email }),
    password: z.string().min(1, { message: d.auth.login.passwordRequired }),
    remember: z.boolean().default(true),
  });
}

function passwordField(d: Dictionary) {
  return z
    .string()
    .min(8, { message: d.auth.validation.passwordMin })
    .max(72, { message: d.auth.validation.passwordMax });
}

export function registerSchema(d: Dictionary) {
  return z
    .object({
      fullName: z
        .string()
        .trim()
        .min(2, { message: d.auth.validation.nameMin })
        .max(80, { message: d.auth.validation.nameMax }),
      email: z.email({ message: d.auth.validation.email }),
      password: passwordField(d),
      confirmPassword: z.string(),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: d.auth.validation.passwordMismatch,
      path: ["confirmPassword"],
    });
}

export function forgotPasswordSchema(d: Dictionary) {
  return z.object({ email: z.email({ message: d.auth.validation.email }) });
}

export function resetPasswordSchema(d: Dictionary) {
  return z
    .object({
      password: passwordField(d),
      confirmPassword: z.string(),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: d.auth.validation.passwordMismatch,
      path: ["confirmPassword"],
    });
}

export type LoginInput = z.input<ReturnType<typeof loginSchema>>;
export type RegisterInput = z.infer<ReturnType<typeof registerSchema>>;
export type ForgotPasswordInput = z.infer<ReturnType<typeof forgotPasswordSchema>>;
export type ResetPasswordInput = z.infer<ReturnType<typeof resetPasswordSchema>>;

/**
 * Supabase Auth errors arrive in English and fairly technical. Map the ones
 * the team will actually hit; pass anything else through untouched rather
 * than swallowing information we didn't anticipate.
 */
export function authErrorMessage(error: { message: string; code?: string }, d: Dictionary) {
  const raw = (error.message ?? "").toLowerCase();
  const e = d.auth.errors;

  if (raw.includes("invalid login credentials")) return e.invalidCredentials;
  if (raw.includes("email not confirmed")) return e.emailNotConfirmed;
  if (raw.includes("user already registered") || raw.includes("already been registered"))
    return e.alreadyRegistered;
  if (raw.includes("password should be at least")) return e.weakPassword;
  if (raw.includes("rate limit") || raw.includes("too many")) return e.rateLimit;
  if (raw.includes("new password should be different")) return e.samePassword;
  if (raw.includes("failed to fetch") || raw.includes("network")) return e.network;

  // GoTrue answers 500 "Error sending confirmation email" when SMTP is
  // unconfigured, rate-limited or rejecting. Nothing the user can fix, and
  // the raw wording reads like their account failed to be created.
  if (raw.includes("sending confirmation email") || raw.includes("sending email"))
    return e.emailSendFailed;

  // supabase-js falls back to JSON.stringify(body) when the error payload has
  // no message field, which is how an empty body reaches the UI as "{}".
  // Anything that carries no information is not worth showing.
  const message = (error.message ?? "").trim();
  if (message.length === 0 || message === "{}" || message === "[object Object]") return e.generic;

  return message;
}
