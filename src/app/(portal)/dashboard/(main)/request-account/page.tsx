import { redirect } from "next/navigation";

export default async function RequestAccountPage() {
  redirect("/dashboard");
}
