import { PageContainer } from "@/components/ui/page-container";
import { ReviewedCorrectionView } from "@/components/admin/reviewed-correction-view";
import { DIOGO_CLOSING_CORRECTION as correction } from "@/lib/billing/reviewed-corrections";
import { getSessionProfile } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function CorrectionPage() {
  const { user, profile } = await getSessionProfile();
  if (!user || profile?.role !== "admin") redirect("/login");
  return <PageContainer title="Correção da fatura" description="Diogo e Patrícia · O7NF1GF9-0031">
    <ReviewedCorrectionView correction={correction} />
  </PageContainer>;
}
