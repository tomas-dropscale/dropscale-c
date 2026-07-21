import { z } from "zod";

export const loginSchema = z.object({
  email: z.email({ message: "Enter a valid email address." }),
  password: z.string().min(1, { message: "Enter your password." }),
  remember: z.boolean().default(true),
});

const passwordField = z
  .string()
  .min(8, { message: "Use at least 8 characters." })
  .max(72, { message: "Use at most 72 characters." });

export const forgotPasswordSchema = z.object({
  email: z.email({ message: "Enter a valid email address." }),
});

export const resetPasswordSchema = z
  .object({
    password: passwordField,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "The passwords do not match.",
    path: ["confirmPassword"],
  });

export type LoginInput = z.input<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/**
 * Supabase Auth errors arrive fairly technical. Map the ones clients will
 * actually hit; pass anything else through untouched rather than swallowing
 * information we didn't anticipate.
 */
export function authErrorMessage(error: { message: string; code?: string }) {
  const raw = error.message.toLowerCase();

  if (raw.includes("invalid login credentials"))
    return "Incorrect email or password.";
  if (raw.includes("email not confirmed"))
    return "This email hasn't been confirmed yet. Check your inbox.";
  if (raw.includes("rate limit") || raw.includes("too many"))
    return "Too many attempts. Wait a moment and try again.";
  if (raw.includes("new password should be different"))
    return "The new password must be different from the current one.";
  if (raw.includes("failed to fetch") || raw.includes("network"))
    return "Connection problem. Check your internet and try again.";

  // Supabase's own wording here talks about @supabase/ssr and code verifiers.
  // Accurate for us, meaningless to a client staring at a login form.
  if (raw.includes("code verifier") || raw.includes("pkce"))
    return "That link couldn't be opened in this browser. Sign in below, or open the link in the browser you started from.";

  const message = error.message?.trim() ?? "";
  if (message.length === 0 || message === "{}" || message === "[object Object]")
    return "Something went wrong. Please try again.";

  return message;
}
