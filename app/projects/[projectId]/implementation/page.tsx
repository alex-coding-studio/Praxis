import { redirect } from 'next/navigation';

export default async function RetiredImplementationPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ source?: string }>;
}) {
  const { projectId } = await params;
  const { source } = await searchParams;
  redirect(
    `/projects/${projectId}/delivery${source ? `?target=${encodeURIComponent(source)}` : ''}`,
  );
}
