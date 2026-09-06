import { notFound } from 'next/navigation';
import { ProjectShell } from '@/components/project-shell';
import { DeliveryWorkspace } from '@/components/delivery-workspace';
import { readDeliveryWorkspace } from '@/lib/modules/delivery/service';
import { readContextBrowser } from '@/lib/modules/product-context/catalog';
import {
  getProject,
  listProjects,
  getGitHubRepositoryUrl,
} from '@/lib/project-registry';

export const dynamic = 'force-dynamic';
export default async function DeliveryPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const project = await getProject((await params).projectId);
  if (!project) notFound();
  return (
    <ProjectShell
      project={project}
      projects={await listProjects()}
      repositoryUrl={getGitHubRepositoryUrl(project)}
    >
      <DeliveryWorkspace
        projectId={project.id}
        initialWorkspace={await readDeliveryWorkspace(project)}
        folders={await readContextBrowser(project)}
      />
    </ProjectShell>
  );
}
