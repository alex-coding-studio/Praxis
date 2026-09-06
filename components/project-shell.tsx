'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Boxes,
  ChevronDown,
  CircleDot,
  ExternalLink,
  FileText,
  FolderGit2,
  FolderOpen,
  LoaderCircle,
  Play,
  LayoutDashboard,
  Network,
  Route,
  Settings,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { siGithub } from 'simple-icons/icons';
import type { RegisteredProject } from '@/lib/project-registry';
import { requestProjectReveal } from '@/lib/project-reveal';
import { cn } from '@/lib/utils';
import { useUiText } from '@/components/ui-language-provider';

const navigation = [
  { label: 'Overview', icon: LayoutDashboard, path: '', available: true },
  {
    label: 'Product context',
    icon: FileText,
    path: '/context',
    available: true,
  },
  {
    label: 'Product Discovery & Design',
    icon: Sparkles,
    path: '/whats-next',
    available: true,
  },
  {
    label: 'Scope Decomposition',
    icon: Boxes,
    path: '/decomposition',
    available: true,
  },
  {
    label: 'Domain Modeling',
    icon: Network,
    path: '/domain-model',
    available: true,
  },
  {
    label: 'Delivery Planning',
    icon: Route,
    path: '/what-to-do',
    available: true,
  },
  {
    label: 'Development Delivery',
    icon: Play,
    path: '/delivery',
    available: true,
    badge: undefined,
  },
];

export function ProjectShell({
  project,
  projects,
  repositoryUrl,
  children,
}: {
  project: RegisteredProject;
  projects: RegisteredProject[];
  repositoryUrl: string | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useUiText();
  const [openingProject, setOpeningProject] = useState(false);
  const [projectOpenError, setProjectOpenError] = useState('');

  async function openProjectLocation() {
    setOpeningProject(true);
    setProjectOpenError('');
    try {
      await requestProjectReveal(project.id);
    } catch (error) {
      setProjectOpenError(
        error instanceof Error
          ? t(error.message)
          : t('Could not open project location.'),
      );
    } finally {
      setOpeningProject(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground lg:grid lg:grid-cols-[272px_1fr]">
      <aside className="border-b border-border bg-[color-mix(in_oklch,var(--background),var(--foreground)_2%)] lg:sticky lg:top-0 lg:h-screen lg:border-r lg:border-b-0">
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-3 border-b border-border p-3 lg:block lg:p-4">
            <Link
              href="/"
              className="flex shrink-0 items-center gap-2.5 px-1 lg:mb-4"
            >
              <div className="grid size-8 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
                P
              </div>
              <span className="hidden font-semibold tracking-tight sm:inline">
                Praxis
              </span>
            </Link>

            <div className="relative min-w-0 flex-1">
              <select
                suppressHydrationWarning
                aria-label={t('Switch project')}
                value={project.id}
                onChange={(event) =>
                  router.push(`/projects/${event.target.value}`)
                }
                className="h-12 w-full appearance-none rounded-xl border border-border bg-background px-3 pr-9 text-left text-sm font-medium outline-none transition focus:border-ring focus:ring-3 focus:ring-ring/20"
              >
                {projects.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>

          <nav
            className="flex gap-1 overflow-x-auto p-2 lg:grid lg:p-3"
            aria-label={t('Project navigation')}
          >
            {navigation.map((item) => {
              const Icon = item.icon;
              const href = `/projects/${project.id}${item.path}`;
              const active = item.available && pathname === href;
              const content = (
                <>
                  <Icon className="size-4" />
                  <span>{t(item.label)}</span>
                  {item.badge ? (
                    <span className="ml-auto text-[10px] opacity-65">
                      {t(item.badge)}
                    </span>
                  ) : null}
                  {!item.available ? (
                    <span className="ml-auto text-[10px] uppercase tracking-wide">
                      {t('Soon')}
                    </span>
                  ) : null}
                </>
              );
              const className = cn(
                'flex h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition lg:gap-3',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground',
                item.available &&
                  !active &&
                  'hover:bg-muted hover:text-foreground',
                !item.available && 'opacity-55',
              );
              return item.available ? (
                <Link key={item.label} href={href} className={className}>
                  {content}
                </Link>
              ) : (
                <div key={item.label} className={className}>
                  {content}
                </div>
              );
            })}
          </nav>

          <div className="mt-auto border-t border-border p-3">
            <button
              type="button"
              className="flex h-9 w-full min-w-0 items-center gap-3 rounded-lg px-3 text-left text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
              title={t('Open project location')}
              disabled={openingProject}
              onClick={() => void openProjectLocation()}
            >
              {project.kind === 'repository' ? (
                <FolderGit2 className="size-4 shrink-0" />
              ) : (
                <CircleDot className="size-4 shrink-0" />
              )}
              <span className="truncate">{project.rootPath}</span>
              {openingProject ? (
                <LoaderCircle className="ml-auto size-4 shrink-0 animate-spin" />
              ) : (
                <FolderOpen className="ml-auto size-4 shrink-0" />
              )}
            </button>
            {repositoryUrl ? (
              <a
                href={repositoryUrl}
                target="_blank"
                rel="noreferrer"
                className="flex h-9 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <GitHubIcon />
                {t('Repository')}
                <ExternalLink className="ml-auto size-4 shrink-0" />
              </a>
            ) : null}
            <Link
              href={`/settings?project=${project.id}`}
              className={cn(
                'flex h-9 items-center gap-3 rounded-lg px-3 text-sm transition',
                pathname === '/settings'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Settings className="size-4" />
              {t('Settings')}
            </Link>
            {projectOpenError ? (
              <p
                role="alert"
                className="px-3 pt-1 text-[10px] text-destructive"
              >
                {projectOpenError}
              </p>
            ) : null}
          </div>
        </div>
      </aside>

      <main className="min-w-0">{children}</main>
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-current">
      <path d={siGithub.path} />
    </svg>
  );
}
