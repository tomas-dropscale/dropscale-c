import { redirect } from "next/navigation";

/**
 * Keep old bookmarks and notifications safe while the legacy client surface
 * is retired. The admin layout authenticates and authorizes before this runs.
 */
export default function ClientsRedirectPage() {
  redirect("/admin/client-onboarding");
}
