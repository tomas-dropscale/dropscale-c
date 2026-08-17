import { redirect } from "next/navigation";

/**
 * The clients workspace lives at /admin/clients (roster, onboarding links and
 * commercial terms in one place). This route only survives so old bookmarks
 * and notification deep-links keep landing somewhere useful.
 */
export default function ClientOnboardingPage() {
  redirect("/admin/clients");
}
