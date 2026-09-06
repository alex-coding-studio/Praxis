import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ANY_PLANNING_RELATIVE_PATH,
  CONTEXT_LIBRARY_MARKDOWN,
  PlanningPathEscapeError,
  PlanningPathKindError,
  PlanningPathShapeError,
  PlanningPathSizeError,
  PRODUCT_CONTEXT_DOCUMENT_SHAPES,
  TASK_GRAPH_MARKDOWN_SHAPES,
  resolvePlanningPath,
} from '../lib/planning-paths.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'am-planning-paths-home-'));
process.env.PRAXIS_HOME = HOME;

const RUN = 'RUN-11111111-2222-4333-8444-555555555555';
const CANDIDATE = 'CANDIDATE-abcdef12';
const NODE = 'NODE-abcdef12';
const CARD = '11111111-2222-4333-8444-555555555555';

const SUPPORTED_SHAPES: Array<[string, string]> = [
  ['Context Library Markdown', 'context/product/notes.md'],
  ['Context Library nested folder', 'context/product/sub-area/notes.markdown'],
  ['Task Graph node resource', `task-graph/nodes/${NODE}/resources/a.md`],
  ['What’s Next node resource', `whats-next/nodes/${NODE}/resources/a.md`],
  ['Task Graph node output', `task-graph/nodes/${NODE}/output.md`],
  ['What’s Next node output', `whats-next/nodes/${NODE}/output.md`],
  [
    'Break It Down Candidate output',
    `task-decomposition/runs/${RUN}/candidates/${CANDIDATE}/output.md`,
  ],
  [
    'What’s Next Candidate output',
    `whats-next/runs/${RUN}/candidates/${CANDIDATE}/output.md`,
  ],
  ['What’s Next reflection', `whats-next/runs/${RUN}/reflection.md`],
  ['What’s Next response', `whats-next/runs/${RUN}/response.md`],
  ['What’s Next summary', `whats-next/runs/${RUN}/summary.md`],
  ['Domain Model summary', `domain-model/runs/${RUN}/summary.md`],
  ['What to Do response', `what-to-do/runs/${RUN}/response.md`],
  [
    'What to Do Delivery Contract output',
    `what-to-do/runs/${RUN}/contracts/${NODE}/output.md`,
  ],
  ['What’s Next Run resource', `whats-next/runs/${RUN}/resources/a.md`],
  [
    'What’s Next Run User Input',
    `whats-next/runs/${RUN}/context/input/user-input.md`,
  ],
  ['Implementation Plan', `implementation/cards/${CARD}/00000003/plan.md`],
  ['Accepted Action output', `implementation/cards/${CARD}/00000004/output.md`],
];

async function planningProject(label: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `am-planning-${label}-`));
  const planningPath = path.join(root, '.praxis');
  await mkdir(planningPath, { recursive: true });
  return {
    project: {
      id: 'p',
      kind: 'standalone',
      name: label,
      description: '',
      rootPath: root,
      codePath: null,
      planningPath,
      createdAt: '2026-09-01T00:00:00.000Z',
    } as RegisteredProject,
    root,
    planningPath,
  };
}

async function writeInside(planningPath: string, relative: string, body = 'x') {
  const file = path.join(planningPath, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  return file;
}

async function snapshot(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const records: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      records.push(`symlink ${entry.name} -> ${await readlink(full)}`);
      continue;
    }
    if (entry.isDirectory()) {
      records.push(`dir ${entry.name}`);
      records.push(
        ...(await snapshot(full)).map((child) => `${entry.name}/${child}`),
      );
      continue;
    }
    const body = await readFile(full);
    records.push(
      `file ${entry.name} ${body.byteLength} ${createHash('sha256').update(body).digest('hex')}`,
    );
  }
  return records.sort();
}

void test('a valid existing file inside the planning root resolves', async () => {
  const { project, planningPath } = await planningProject('valid');
  const file = await writeInside(planningPath, 'context/product/notes.md');
  const resolved = await resolvePlanningPath(
    project,
    'context/product/notes.md',
    { shapes: TASK_GRAPH_MARKDOWN_SHAPES, require: 'file' },
  );
  assert.equal(resolved.absolutePath, await realpathOf(file));
  assert.equal(resolved.relativePath, 'context/product/notes.md');
  assert.equal(resolved.size, 1);
});

async function realpathOf(file: string) {
  const { realpath } = await import('node:fs/promises');
  return realpath(file);
}

void test('every supported Task Graph Markdown shape is accepted', async () => {
  const { project, planningPath } = await planningProject('shapes');
  for (const [label, relative] of SUPPORTED_SHAPES) {
    await writeInside(planningPath, relative);
    const resolved = await resolvePlanningPath(project, relative, {
      shapes: TASK_GRAPH_MARKDOWN_SHAPES,
    });
    assert.equal(resolved.relativePath, relative, label);
  }
});

void test('Product Context accepts formal artifacts but excludes transient Agent output', async () => {
  const accepted = [
    'context/product/notes.md',
    `whats-next/nodes/${NODE}/output.md`,
    `task-graph/nodes/${NODE}/output.md`,
    `domain-model/runs/${RUN}/summary.md`,
    `what-to-do/runs/${RUN}/contracts/${NODE}/output.md`,
    `implementation/cards/${CARD}/00000003/plan.md`,
    `implementation/cards/${CARD}/00000004/output.md`,
  ];
  const { project, planningPath } = await planningProject('context-shapes');
  for (const relative of accepted) {
    await writeInside(planningPath, relative);
    assert.equal(
      (
        await resolvePlanningPath(project, relative, {
          shapes: PRODUCT_CONTEXT_DOCUMENT_SHAPES,
        })
      ).relativePath,
      relative,
    );
  }
  await writeInside(planningPath, `whats-next/runs/${RUN}/response.md`);
  await assert.rejects(
    () =>
      resolvePlanningPath(project, `whats-next/runs/${RUN}/response.md`, {
        shapes: PRODUCT_CONTEXT_DOCUMENT_SHAPES,
      }),
    PlanningPathShapeError,
  );
});

void test('an unrelated shape is rejected', async () => {
  const { project, planningPath } = await planningProject('unrelated');
  await writeInside(planningPath, 'runtime/jobs/output.log');
  await assert.rejects(
    () =>
      resolvePlanningPath(project, 'runtime/jobs/output.log', {
        shapes: TASK_GRAPH_MARKDOWN_SHAPES,
      }),
    PlanningPathShapeError,
  );
});

void test('absolute and drive-qualified paths are rejected', async () => {
  const { project } = await planningProject('absolute');
  for (const hostile of [
    '/etc/passwd',
    '/tmp/elsewhere.md',
    'C:\\Windows\\system.ini',
    'c:/Windows/system.ini',
    '\\\\server\\share\\file.md',
    '\\etc\\passwd',
  ])
    await assert.rejects(
      () => resolvePlanningPath(project, hostile),
      PlanningPathShapeError,
      hostile,
    );
});

void test('POSIX, backslash and normalized traversal are rejected', async () => {
  const { project } = await planningProject('traversal');
  for (const hostile of [
    '../outside.md',
    '../../etc/passwd',
    'context/../../outside.md',
    '..\\outside.md',
    'context\\..\\..\\outside.md',
    'context/product/../../../outside.md',
  ])
    await assert.rejects(
      () => resolvePlanningPath(project, hostile),
      PlanningPathShapeError,
      hostile,
    );
});

void test('a sibling directory sharing the string prefix is rejected', async () => {
  const { project, root, planningPath } = await planningProject('prefix');
  const sibling = `${planningPath}-other`;
  await mkdir(sibling, { recursive: true });
  await writeFile(path.join(sibling, 'notes.md'), 'outside');
  await symlink(
    path.join(sibling, 'notes.md'),
    path.join(planningPath, 'linked.md'),
  );
  await assert.rejects(
    () => resolvePlanningPath(project, 'linked.md'),
    PlanningPathEscapeError,
  );
  assert.ok(root.length > 0);
});

void test('a symlinked file pointing outside the planning root is rejected', async () => {
  const { project, planningPath } = await planningProject('symlink-file');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'am-planning-outside-'));
  const secret = path.join(outside, 'secret.md');
  await writeFile(secret, 'outside content');
  await mkdir(path.join(planningPath, 'context', 'product'), {
    recursive: true,
  });
  await symlink(
    secret,
    path.join(planningPath, 'context', 'product', 'notes.md'),
  );
  await assert.rejects(
    () =>
      resolvePlanningPath(project, 'context/product/notes.md', {
        shapes: TASK_GRAPH_MARKDOWN_SHAPES,
      }),
    PlanningPathEscapeError,
  );
});

void test('a symlinked directory pointing outside the planning root is rejected', async () => {
  const { project, planningPath } = await planningProject('symlink-dir');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'am-planning-outdir-'));
  await mkdir(path.join(outside, 'product'), { recursive: true });
  await writeFile(path.join(outside, 'product', 'notes.md'), 'outside');
  await symlink(outside, path.join(planningPath, 'context'));
  await assert.rejects(
    () =>
      resolvePlanningPath(project, 'context/product/notes.md', {
        shapes: TASK_GRAPH_MARKDOWN_SHAPES,
      }),
    PlanningPathEscapeError,
  );
});

void test('a symlink resolving to another path inside the root is accepted', async () => {
  const { project, planningPath } = await planningProject('symlink-inside');
  const real = await writeInside(
    planningPath,
    `whats-next/nodes/${NODE}/output.md`,
    'inside',
  );
  await mkdir(path.join(planningPath, 'context', 'product'), {
    recursive: true,
  });
  await symlink(
    real,
    path.join(planningPath, 'context', 'product', 'notes.md'),
  );
  const resolved = await resolvePlanningPath(
    project,
    'context/product/notes.md',
    { shapes: TASK_GRAPH_MARKDOWN_SHAPES },
  );
  assert.equal(resolved.absolutePath, await realpathOf(real));
});

void test('a directory is rejected when a regular file is required', async () => {
  const { project, planningPath } = await planningProject('kind-file');
  await mkdir(path.join(planningPath, 'context', 'product', 'notes.md'), {
    recursive: true,
  });
  await assert.rejects(
    () =>
      resolvePlanningPath(project, 'context/product/notes.md', {
        shapes: TASK_GRAPH_MARKDOWN_SHAPES,
        require: 'file',
      }),
    PlanningPathKindError,
  );
});

void test('a file is rejected when a directory is required', async () => {
  const { project, planningPath } = await planningProject('kind-dir');
  await writeInside(planningPath, 'context/product/notes.md');
  await assert.rejects(
    () =>
      resolvePlanningPath(project, 'context/product/notes.md', {
        shapes: TASK_GRAPH_MARKDOWN_SHAPES,
        require: 'directory',
      }),
    PlanningPathKindError,
  );
});

void test('a file over the size limit is rejected and the limit is the caller’s', async () => {
  const { project, planningPath } = await planningProject('size');
  await writeInside(planningPath, 'context/product/notes.md', 'x'.repeat(64));
  await assert.rejects(
    () =>
      resolvePlanningPath(project, 'context/product/notes.md', {
        shapes: TASK_GRAPH_MARKDOWN_SHAPES,
        maxBytes: 16,
      }),
    PlanningPathSizeError,
  );
  const allowed = await resolvePlanningPath(
    project,
    'context/product/notes.md',
    { shapes: TASK_GRAPH_MARKDOWN_SHAPES, maxBytes: 128 },
  );
  assert.equal(allowed.size, 64);
});

void test('a missing target surfaces ENOENT so callers keep deciding', async () => {
  const { project } = await planningProject('missing');
  await assert.rejects(
    () =>
      resolvePlanningPath(project, 'context/product/absent.md', {
        shapes: TASK_GRAPH_MARKDOWN_SHAPES,
      }),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'ENOENT');
      assert.ok(!(error instanceof PlanningPathShapeError));
      assert.ok(!(error instanceof PlanningPathEscapeError));
      return true;
    },
  );
});

void test('a rejected path mutates neither the planning store nor anything outside', async () => {
  const { project, planningPath } = await planningProject('no-mutation');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'am-planning-guard-'));
  await writeFile(path.join(outside, 'secret.md'), 'untouched');
  await writeInside(planningPath, 'context/product/notes.md', 'kept');
  const before = await snapshot(planningPath);
  const outsideBefore = await snapshot(outside);

  for (const hostile of [
    '../outside.md',
    '/etc/passwd',
    'C:\\Windows\\system.ini',
    'context\\..\\..\\outside.md',
    'runtime/jobs/output.log',
  ])
    await assert.rejects(() =>
      resolvePlanningPath(project, hostile, {
        shapes: TASK_GRAPH_MARKDOWN_SHAPES,
      }),
    );

  assert.deepEqual(await snapshot(planningPath), before);
  assert.deepEqual(await snapshot(outside), outsideBefore);
  await rm(outside, { recursive: true, force: true });
});

void test('the permissive shape still refuses traversal and absolute input', async () => {
  const { project, planningPath } = await planningProject('permissive');
  await writeInside(planningPath, 'runtime/jobs/output.log');
  const resolved = await resolvePlanningPath(
    project,
    'runtime/jobs/output.log',
    {
      shapes: [ANY_PLANNING_RELATIVE_PATH],
    },
  );
  assert.match(resolved.absolutePath, /runtime\/jobs\/output\.log$/);
  for (const hostile of ['../x', '/etc/passwd', 'a\\..\\..\\b'])
    await assert.rejects(
      () =>
        resolvePlanningPath(project, hostile, {
          shapes: [ANY_PLANNING_RELATIVE_PATH],
        }),
      PlanningPathShapeError,
    );
});

void test('the Context Library shape is narrower than the Task Graph set', async () => {
  const { project, planningPath } = await planningProject('context-narrow');
  await writeInside(planningPath, `whats-next/nodes/${NODE}/output.md`);
  await assert.rejects(
    () =>
      resolvePlanningPath(project, `whats-next/nodes/${NODE}/output.md`, {
        shapes: [CONTEXT_LIBRARY_MARKDOWN],
        within: 'context',
      }),
    PlanningPathShapeError,
  );
});

void test('readTaskGraphMarkdownResource uses the shared boundary and keeps its public message', async () => {
  const { readTaskGraphMarkdownResource } =
    await import('../lib/graph/task/model.ts');
  const { PublicApiError } = await import('../lib/api-errors.ts');
  const { project, planningPath } = await planningProject('read-resource');
  await writeInside(planningPath, 'context/product/notes.md', '# kept');

  const ok = await readTaskGraphMarkdownResource(
    project,
    'context/product/notes.md',
  );
  assert.equal(ok.markdown, '# kept');
  assert.equal(ok.fileName, 'notes.md');

  for (const hostile of [
    '../outside.md',
    '/etc/passwd',
    'C:\\Windows\\system.ini',
    'context\\..\\..\\outside.md',
    'runtime/jobs/output.log',
  ])
    await assert.rejects(
      () => readTaskGraphMarkdownResource(project, hostile),
      (error: unknown) => {
        assert.ok(error instanceof PublicApiError, hostile);
        assert.equal(
          (error as Error).message,
          'The source document path is invalid.',
        );
        assert.equal((error as { status: number }).status, 400);
        return true;
      },
    );
});

void test('Latest Response reads canonical What’s Next and Domain Model summaries', async () => {
  const { project, planningPath } = await planningProject('run-summaries');
  const { readTaskGraphMarkdownResource } =
    await import('../lib/graph/task/model.ts');
  const summaries = [
    [
      `whats-next/runs/${RUN}/summary.md`,
      '# Summary\n\n## Suggested next step\n\nClose the loop.\n',
    ],
    [
      `domain-model/runs/${RUN}/summary.md`,
      '# Applied\n\nAdded 2, updated 1, removed 0.\n',
    ],
  ] as const;
  for (const [relative, markdown] of summaries) {
    await writeInside(planningPath, relative, markdown);
    assert.equal(
      (await readTaskGraphMarkdownResource(project, relative)).markdown,
      markdown,
    );
  }
});

void test('readTaskGraphMarkdownResource keeps a missing file internal, not public', async () => {
  const { readTaskGraphMarkdownResource } =
    await import('../lib/graph/task/model.ts');
  const { PublicApiError, apiErrorResponse } =
    await import('../lib/api-errors.ts');
  const { project } = await planningProject('read-missing');

  let raised: unknown;
  try {
    await readTaskGraphMarkdownResource(project, 'context/product/absent.md');
  } catch (error) {
    raised = error;
  }
  assert.ok(raised);
  assert.ok(!(raised instanceof PublicApiError));
  assert.equal((raised as NodeJS.ErrnoException).code, 'ENOENT');

  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => captured.push(parts.join(' '));
  let response;
  try {
    response = apiErrorResponse(
      raised,
      'Could not read the source document.',
      'GET /api/projects/[projectId]/resources',
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(response.status, 500);
  const body = (await response.json()) as {
    error: string;
    correlationId: string;
  };
  assert.equal(body.error, 'Could not read the source document.');
  assert.ok(!JSON.stringify(body).includes('/'));
  assert.equal(captured.length, 1);
  assert.ok(captured[0]!.includes(body.correlationId));
  assert.ok(captured[0]!.includes('ENOENT'));
});

void test('readPlanningFile keeps its internal messages and size boundary', async () => {
  const { readPlanningFile } =
    await import('../lib/modules/implementation/planning-sources.ts');
  const { PublicApiError } = await import('../lib/api-errors.ts');
  const { project, planningPath } = await planningProject('planning-file');
  await writeInside(planningPath, 'runtime/notes.txt', 'body');

  assert.equal(await readPlanningFile(project, 'runtime/notes.txt'), 'body');

  await assert.rejects(
    () => readPlanningFile(project, '../outside.md'),
    (error: unknown) => {
      assert.ok(!(error instanceof PublicApiError));
      assert.equal((error as Error).message, 'Invalid planning file path.');
      return true;
    },
  );

  await mkdir(path.join(planningPath, 'runtime', 'folder'), {
    recursive: true,
  });
  await assert.rejects(
    () => readPlanningFile(project, 'runtime/folder'),
    (error: unknown) => {
      assert.equal(
        (error as Error).message,
        'Planning resource is missing or too large.',
      );
      return true;
    },
  );

  await assert.rejects(
    () => readPlanningFile(project, 'runtime/notes.txt', 2),
    (error: unknown) => {
      assert.equal(
        (error as Error).message,
        'Planning resource is missing or too large.',
      );
      return true;
    },
  );

  const outside = await mkdtemp(path.join(os.tmpdir(), 'am-planning-esc-'));
  await writeFile(path.join(outside, 'x.md'), 'outside');
  await symlink(path.join(outside, 'x.md'), path.join(planningPath, 'link.md'));
  await assert.rejects(
    () => readPlanningFile(project, 'link.md'),
    (error: unknown) => {
      assert.equal(
        (error as Error).message,
        'Planning resource escapes the project.',
      );
      return true;
    },
  );
  await rm(outside, { recursive: true, force: true });
});

void test('the migrated call sites import the shared resolver', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const [name, resolver] of [
    ['graph/task/nodes.ts', '../../planning-paths.ts'],
    ['planning-documents.ts', './planning-paths.ts'],
  ]) {
    const source = await readFile(
      new URL(`../lib/${name}`, import.meta.url),
      'utf8',
    );
    assert.ok(source.includes(`from '${resolver}'`), name);
    assert.match(source, /resolvePlanningPath\(/, name);
    assert.ok(
      !/startsWith\(`\$\{[a-zA-Z]+Root\}\$\{path\.sep\}`\)/.test(source),
      `${name} must not keep its own containment check`,
    );
  }
});

async function contextProject(label: string) {
  const fixture = await planningProject(label);
  await mkdir(path.join(fixture.planningPath, 'context', 'product'), {
    recursive: true,
  });
  return fixture;
}

async function nodeDirectories(planningPath: string, graphRoot: string) {
  return (
    await readdir(path.join(planningPath, graphRoot, 'nodes')).catch(() => [])
  ).sort((left, right) => left.localeCompare(right));
}

void test('createStartNode rejects a Context reference that symlinks outside the planning root', async () => {
  const { createStartNode } = await import('../lib/graph/task/model.ts');
  const { PublicApiError } = await import('../lib/api-errors.ts');
  const { project, planningPath } = await contextProject('ctx-escape');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'am-planning-ctx-out-'));
  const secret = path.join(outside, 'secret.md');
  await writeFile(secret, 'must not be reachable');
  await symlink(
    secret,
    path.join(planningPath, 'context', 'product', 'linked.md'),
  );
  const before = await snapshot(planningPath);

  await assert.rejects(
    () =>
      createStartNode(
        project,
        {
          title: 'A node that must not be created',
          contextRefs: ['context/product/linked.md'],
          files: [],
          idea: 'An idea long enough to satisfy the guard.',
        },
        'whats-next',
      ),
    (error: unknown) => {
      assert.ok(error instanceof PublicApiError);
      assert.equal(
        (error as Error).message,
        'A selected Product Context document is no longer available.',
      );
      assert.equal((error as { status: number }).status, 409);
      return true;
    },
  );

  assert.deepEqual(await nodeDirectories(planningPath, 'whats-next'), []);
  assert.deepEqual(await snapshot(planningPath), before);
  assert.equal(await readFile(secret, 'utf8'), 'must not be reachable');
  await rm(outside, { recursive: true, force: true });
});

void test('updateStartNode rejects the same escape without changing the stored node', async () => {
  const { createStartNode, updateStartNode, listTaskGraphNodes } =
    await import('../lib/graph/task/model.ts');
  const { PublicApiError } = await import('../lib/api-errors.ts');
  const { project, planningPath } = await contextProject('ctx-escape-update');
  await writeFile(
    path.join(planningPath, 'context', 'product', 'valid.md'),
    'valid source',
  );
  const created = await createStartNode(
    project,
    {
      title: 'An existing start node',
      contextRefs: ['context/product/valid.md'],
      files: [],
    },
    'whats-next',
  );

  const outside = await mkdtemp(path.join(os.tmpdir(), 'am-planning-upd-out-'));
  await writeFile(path.join(outside, 'secret.md'), 'outside');
  await symlink(
    path.join(outside, 'secret.md'),
    path.join(planningPath, 'context', 'product', 'linked.md'),
  );
  const before = await snapshot(planningPath);

  await assert.rejects(
    () =>
      updateStartNode(
        project,
        {
          id: created.node.id,
          title: 'An existing start node',
          contextRefs: ['context/product/linked.md'],
          retainedAttachmentRefs: [],
          files: [],
        },
        'whats-next',
      ),
    (error: unknown) => {
      assert.ok(error instanceof PublicApiError);
      assert.equal(
        (error as Error).message,
        'A selected Product Context document is no longer available.',
      );
      return true;
    },
  );

  assert.deepEqual(await snapshot(planningPath), before);
  const nodes = await listTaskGraphNodes(project, 'whats-next');
  const stored = nodes.find((node) => node.id === created.node.id);
  assert.deepEqual(
    stored?.resources?.map((resource) => resource.path),
    ['context/product/valid.md'],
  );
  await rm(outside, { recursive: true, force: true });
});

void test('duplicate Context references are deduplicated in first-occurrence order', async () => {
  const { createStartNode } = await import('../lib/graph/task/model.ts');
  const { project, planningPath } = await contextProject('ctx-dedup');
  for (const name of ['alpha.md', 'beta.md', 'gamma.md'])
    await writeFile(
      path.join(planningPath, 'context', 'product', name),
      `body of ${name}`,
    );

  const created = await createStartNode(
    project,
    {
      title: 'A node with repeated references',
      contextRefs: [
        'context/product/gamma.md',
        'context/product/alpha.md',
        'context/product/gamma.md',
        'context/product/beta.md',
        'context/product/alpha.md',
      ],
      files: [],
    },
    'whats-next',
  );

  const contextPaths = created.node.resources
    .filter((resource: { kind: string }) => resource.kind === 'context')
    .map((resource: { path: string }) => resource.path);
  assert.deepEqual(contextPaths, [
    'context/product/gamma.md',
    'context/product/alpha.md',
    'context/product/beta.md',
  ]);
  assert.equal(new Set(contextPaths).size, contextPaths.length);
});

void test('a Context reference outside the Context Library shape is rejected by the real call path', async () => {
  const { createStartNode } = await import('../lib/graph/task/model.ts');
  const { PublicApiError } = await import('../lib/api-errors.ts');
  const { project, planningPath } = await contextProject('ctx-shape');
  await writeInside(planningPath, `whats-next/nodes/${NODE}/output.md`, 'node');
  const before = await nodeDirectories(planningPath, 'whats-next');

  for (const hostile of [
    `whats-next/nodes/${NODE}/output.md`,
    '../outside.md',
    '/etc/passwd',
    'context\\..\\..\\outside.md',
  ])
    await assert.rejects(
      () =>
        createStartNode(
          project,
          {
            title: 'Rejected before creation',
            contextRefs: [hostile],
            files: [],
            idea: 'An idea long enough to satisfy the guard.',
          },
          'whats-next',
        ),
      (error: unknown) => {
        assert.ok(error instanceof PublicApiError, hostile);
        assert.equal(
          (error as Error).message,
          'A selected Product Context document is no longer available.',
        );
        return true;
      },
    );

  assert.deepEqual(await nodeDirectories(planningPath, 'whats-next'), before);
});
