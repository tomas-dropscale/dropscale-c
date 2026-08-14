import { PerformancePrototype } from "@/components/admin/performance-prototype";

type AnalyticsSearchParams = Promise<{
  client?: string | string[];
  store?: string | string[];
  campaign?: string | string[];
}>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AnalyticsVisualPreviewPage({
  searchParams,
}: {
  searchParams: AnalyticsSearchParams;
}) {
  const query = await searchParams;

  return (
    <PerformancePrototype
      view="analytics"
      analyticsTarget={{
        clientId: first(query.client),
        storeId: first(query.store),
        campaignId: first(query.campaign),
      }}
    />
  );
}
