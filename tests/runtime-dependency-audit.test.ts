import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeRuntimeDependencies,
  stronglyConnectedComponents,
  type DependencyGraph,
} from '../lib/graph/runtime-dependencies.ts';
import {
  AUDIT_EXCLUSIONS,
  AUDIT_SOURCE_ROOTS,
  formatAudit,
  runAudit,
} from '../scripts/audit-runtime-dependencies.ts';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const FIXTURES = 'tests/fixtures/dep-audit';

function analyzeFixture(subdirectories: string[]): DependencyGraph {
  return analyzeRuntimeDependencies({
    projectRoot: PROJECT_ROOT,
    sourceRoots: subdirectories.map((name) => `${FIXTURES}/${name}`),
    aliasPrefix: '@/',
    aliasTarget: PROJECT_ROOT,
  });
}

function runtimeTargets(graph: DependencyGraph, from: string) {
  return graph.runtimeEdges
    .filter((edge) => edge.from.endsWith(from))
    .map((edge) => path.basename(edge.to))
    .sort();
}

void test('a pure import type pair produces no runtime edge or cycle', () => {
  const graph = analyzeFixture(['typeonly']);
  const between = graph.runtimeEdges.filter(
    (edge) =>
      edge.from.endsWith('typeonly/a.ts') ||
      edge.from.endsWith('typeonly/b.ts'),
  );
  assert.deepEqual(between, []);
  assert.equal(graph.components.length, 0);
  assert.ok(graph.typeOnlyEdges.length >= 2);
});

void test('an inline type-only named import produces no runtime edge', () => {
  const graph = analyzeFixture(['typeonly']);
  assert.deepEqual(runtimeTargets(graph, 'typeonly/inline.ts'), []);
  assert.ok(
    graph.typeOnlyEdges.some((edge) =>
      edge.from.endsWith('typeonly/inline.ts'),
    ),
  );
});

void test('a mixed type and value import produces one runtime edge', () => {
  const graph = analyzeFixture(['mixed']);
  assert.deepEqual(runtimeTargets(graph, 'mixed/consumer.ts'), ['value.ts']);
  const edge = graph.runtimeEdges.find((item) =>
    item.from.endsWith('mixed/consumer.ts'),
  );
  assert.equal(edge?.form, 'static-import');
  assert.equal(edge?.line, 1);
});

void test('a side-effect import produces a runtime edge marked as such', () => {
  const graph = analyzeFixture(['sideeffect']);
  const edge = graph.runtimeEdges.find((item) =>
    item.from.endsWith('sideeffect/consumer.ts'),
  );
  assert.equal(edge?.form, 'side-effect-import');
  assert.ok(edge?.to.endsWith('register.ts'));
});

void test('type-only re-export creates no edge while runtime and star re-exports do', () => {
  const graph = analyzeFixture(['reexport']);
  assert.deepEqual(runtimeTargets(graph, 'reexport/type-only.ts'), []);
  assert.deepEqual(runtimeTargets(graph, 'reexport/runtime.ts'), ['source.ts']);
  assert.deepEqual(runtimeTargets(graph, 'reexport/star.ts'), ['source.ts']);
  assert.equal(
    graph.runtimeEdges.find((edge) => edge.from.endsWith('reexport/runtime.ts'))
      ?.form,
    'runtime-re-export',
  );
  assert.equal(
    graph.runtimeEdges.find((edge) => edge.from.endsWith('reexport/star.ts'))
      ?.form,
    'star-re-export',
  );
});

void test('a literal dynamic import is an edge marked dynamic and a require is recognized', () => {
  const graph = analyzeFixture(['dynamic']);
  const dynamic = graph.runtimeEdges.find((edge) =>
    edge.from.endsWith('dynamic/literal.ts'),
  );
  assert.equal(dynamic?.form, 'dynamic-import');
  assert.ok(dynamic?.to.endsWith('target.ts'));

  const required = graph.runtimeEdges.find((edge) =>
    edge.from.endsWith('dynamic/required.js'),
  );
  assert.equal(required?.form, 'require');
  assert.ok(required?.to.endsWith('target.ts'));
});

void test('a non-literal dynamic import is reported as unresolved evidence', () => {
  const graph = analyzeFixture(['dynamic']);
  const unresolved = graph.unresolvedImports.find((item) =>
    item.from.endsWith('dynamic/nonliteral.ts'),
  );
  assert.equal(unresolved?.reason, 'non-literal');
  assert.equal(unresolved?.form, 'dynamic-import');
  assert.equal(unresolved?.specifier, null);
  assert.ok((unresolved?.line ?? 0) > 0);
  assert.deepEqual(runtimeTargets(graph, 'dynamic/nonliteral.ts'), []);
});

void test('an alias import resolves to the owned module', () => {
  const graph = analyzeFixture(['alias']);
  const edge = graph.runtimeEdges.find((item) =>
    item.from.endsWith('alias/consumer.ts'),
  );
  assert.ok(edge, 'alias import should resolve');
  assert.ok(edge!.to.endsWith('alias/aliased.ts'));
  assert.match(edge!.specifier, /^@\//);
});

void test('index and extension resolution is deterministic', () => {
  const graph = analyzeFixture(['indexdir']);
  const edge = graph.runtimeEdges.find((item) =>
    item.from.endsWith('indexdir/index.ts'),
  );
  assert.ok(edge?.to.endsWith(path.join('nested', 'index.ts')));
});

void test('external packages never become graph nodes', () => {
  const graph = analyzeFixture(['external']);
  assert.deepEqual(runtimeTargets(graph, 'external/consumer.ts'), []);
  assert.ok(graph.externalSpecifiers.includes('node:path'));
  assert.ok(graph.externalSpecifiers.includes('typescript'));
  assert.ok(!graph.modules.some((module) => module.includes('node_modules')));
});

void test('a two-node runtime cycle is one strongly connected component', () => {
  const graph = analyzeFixture(['cycle2']);
  assert.equal(graph.components.length, 1);
  assert.deepEqual(
    graph.components[0]!.files.map((file) => path.basename(file)),
    ['left.ts', 'right.ts'],
  );
  assert.equal(graph.components[0]!.edges.length, 2);
  for (const edge of graph.components[0]!.edges) assert.ok(edge.line > 0);
});

void test('a three-node runtime cycle is one strongly connected component', () => {
  const graph = analyzeFixture(['cycle3']);
  assert.equal(graph.components.length, 1);
  assert.deepEqual(
    graph.components[0]!.files.map((file) => path.basename(file)),
    ['one.ts', 'three.ts', 'two.ts'],
  );
  assert.equal(graph.components[0]!.edges.length, 3);
});

void test('an acyclic graph reports no component', () => {
  const graph = analyzeFixture(['acyclic']);
  assert.equal(graph.components.length, 0);
  assert.equal(graph.runtimeEdges.length, 2);
});

void test('enumeration order does not change the output', () => {
  const forward = analyzeFixture(['cycle3', 'cycle2', 'acyclic']);
  const reverse = analyzeFixture(['acyclic', 'cycle2', 'cycle3']);
  assert.deepEqual(forward.components, reverse.components);
  assert.deepEqual(forward.runtimeEdges, reverse.runtimeEdges);
  assert.deepEqual(forward.modules, reverse.modules);
});

void test('separate runtime surfaces sharing a helper do not fabricate a cycle', () => {
  const graph = analyzeRuntimeDependencies({
    projectRoot: PROJECT_ROOT,
    sourceRoots: [
      `${FIXTURES}/surfaceA`,
      `${FIXTURES}/surfaceB`,
      `${FIXTURES}/indexdir`,
    ],
    surfaces: [
      { name: 'surface-a', entryPatterns: [/surfaceA\/entry\.ts$/] },
      { name: 'surface-b', entryPatterns: [/surfaceB\/entry\.ts$/] },
    ],
  });
  assert.equal(graph.components.length, 0);
  assert.equal(graph.surfaces.length, 2);
  for (const surface of graph.surfaces)
    assert.equal(surface.entryPoints.length, 1, surface.name);
});

void test('an unresolved owned import is visible rather than dropped', () => {
  const graph = analyzeFixture(['unresolved']);
  const unresolved = graph.unresolvedImports.find((item) =>
    item.from.endsWith('unresolved/broken.ts'),
  );
  assert.equal(unresolved?.reason, 'unresolved-internal');
  assert.equal(unresolved?.specifier, './does-not-exist.ts');
  assert.equal(unresolved?.line, 1);
});

void test('malformed source fails the analysis instead of disappearing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'am-dep-broken-'));
  await writeFile(
    path.join(directory, 'broken.ts'),
    'import { unterminated from "./x.ts"\nconst = ;\n',
  );
  await assert.rejects(
    async () =>
      analyzeRuntimeDependencies({
        projectRoot: directory,
        sourceRoots: ['.'],
      }),
    /Failed to parse/,
  );
  await rm(directory, { recursive: true, force: true });
});

void test('strongly connected components are stable under input permutation', () => {
  const nodes = ['a', 'b', 'c', 'd'];
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'a' },
    { from: 'c', to: 'd' },
  ];
  const first = stronglyConnectedComponents(nodes, edges);
  const second = stronglyConnectedComponents(
    [...nodes].reverse(),
    [...edges].reverse(),
  );
  assert.deepEqual(first, second);
  assert.deepEqual(first, [['a', 'b']]);
});

void test('the real audit runs offline and is deterministic', () => {
  const first = runAudit(PROJECT_ROOT);
  const second = runAudit(PROJECT_ROOT);
  assert.equal(first.inputFingerprint, second.inputFingerprint);
  assert.match(first.inputFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.components, second.components);
  assert.deepEqual(first.runtimeEdges, second.runtimeEdges);
  assert.deepEqual(first.modules, second.modules);

  assert.deepEqual(first.sourceRoots, [...AUDIT_SOURCE_ROOTS].sort());
  assert.deepEqual(first.exclusions, [...AUDIT_EXCLUSIONS].sort());
  assert.ok(first.modules.length > 0);
  assert.ok(!first.modules.some((module) => module.startsWith('tests/')));
  assert.ok(
    first.modules.some((module) => module.startsWith('components/ui/')),
  );

  const printed = formatAudit(first);
  assert.ok(printed.includes(first.inputFingerprint));
  assert.match(printed, /owned modules: \d+/);
  assert.match(printed, /runtime strongly connected components: \d+/);
});

void test('the earlier reported modules remain analyzed and free of runtime cycles', () => {
  const graph = runAudit(PROJECT_ROOT);
  const reported = [
    'lib/modules/implementation/execution-types.ts',
    'lib/modules/implementation/coordination-runner.ts',
    'lib/agents/event-driven-transport.ts',
    'lib/agents/codex/app-server-driver.ts',
    'lib/card-host-operations.ts',
    'lib/modules/implementation/worktree.ts',
    'lib/modules/implementation/planning-service.ts',
    'lib/modules/product-discovery/redo.ts',
    'lib/modules/product-discovery/runs.ts',
  ];
  for (const reportedModule of reported)
    assert.ok(
      graph.modules.includes(reportedModule),
      `${reportedModule} must be analyzed`,
    );

  for (const component of graph.components)
    for (const file of component.files)
      assert.ok(
        !reported.includes(file),
        `${file} must not be in a runtime component`,
      );
});

void test('lib keeps provider and business code inside module directories', async () => {
  const libEntries = await readdir(path.join(PROJECT_ROOT, 'lib'), {
    withFileTypes: true,
  });
  const rootFiles = libEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const legacyPrefixes = [
    'agent-graph-',
    'domain-model-',
    'just-do-it-',
    'task-decomposition-',
    'task-graph-',
    'what-to-do-',
    'whats-next-',
  ];
  assert.deepEqual(
    rootFiles.filter((name) =>
      legacyPrefixes.some((prefix) => name.startsWith(prefix)),
    ),
    [],
  );

  for (const provider of ['claude', 'codex', 'deepseek']) {
    const entries = await readdir(
      path.join(PROJECT_ROOT, 'lib/agents', provider),
    );
    assert.ok(entries.length > 0, `${provider} must own its provider files`);
  }

  for (const moduleName of [
    'delivery-planning',
    'domain-modeling',
    'implementation',
    'product-context',
    'product-discovery',
    'scope-decomposition',
  ]) {
    const entries = await readdir(
      path.join(PROJECT_ROOT, 'lib/modules', moduleName),
    );
    assert.ok(entries.length > 0, `${moduleName} must own its module files`);
  }
});

void test('an excluded internal module on a back edge is never reported as acyclic', () => {
  const withExclusion = analyzeRuntimeDependencies({
    projectRoot: PROJECT_ROOT,
    sourceRoots: [`${FIXTURES}/hidden`],
    exclusions: [`${FIXTURES}/hidden/gap`],
  });
  assert.equal(
    withExclusion.components.length,
    0,
    'the excluded module breaks the visible loop',
  );
  assert.ok(
    withExclusion.excludedInternalImports.length > 0,
    'the audit must report the hidden hop instead of a clean acyclic graph',
  );
  const hop = withExclusion.excludedInternalImports.find((item) =>
    item.from.endsWith('hidden/included/entry.ts'),
  );
  assert.ok(hop?.to.endsWith('hidden/gap/bridge.ts'));
  assert.ok(hop!.line > 0);

  const complete = analyzeRuntimeDependencies({
    projectRoot: PROJECT_ROOT,
    sourceRoots: [`${FIXTURES}/hidden`],
  });
  assert.deepEqual(complete.excludedInternalImports, []);
  assert.equal(complete.components.length, 1);
  assert.deepEqual(
    complete.components[0]!.files.map((file) => path.basename(file)),
    ['bridge.ts', 'entry.ts', 'target.ts'],
  );
});

void test('a genuinely one-way excluded leaf is reported without fabricating a cycle', () => {
  const graph = analyzeRuntimeDependencies({
    projectRoot: PROJECT_ROOT,
    sourceRoots: [`${FIXTURES}/oneway`],
    exclusions: [`${FIXTURES}/oneway/leaf`],
  });
  assert.equal(graph.components.length, 0);
  assert.equal(graph.excludedInternalImports.length, 1);
  const reference = graph.excludedInternalImports[0]!;
  assert.ok(reference.from.endsWith('oneway/included/consumer.ts'));
  assert.ok(reference.to.endsWith('oneway/leaf/leaf.ts'));

  const complete = analyzeRuntimeDependencies({
    projectRoot: PROJECT_ROOT,
    sourceRoots: [`${FIXTURES}/oneway`],
  });
  assert.deepEqual(complete.excludedInternalImports, []);
  assert.equal(complete.components.length, 0);
  assert.equal(complete.runtimeEdges.length, 1);
});

void test('a non-module asset reference is recorded without failing the audit', () => {
  const graph = runAudit(PROJECT_ROOT);
  assert.deepEqual(graph.excludedInternalImports, []);
  const asset = graph.assetImports.find((item) => item.to.endsWith('.css'));
  assert.ok(asset, 'the global stylesheet import should be recorded');
  assert.ok(asset!.from.endsWith('app/layout.tsx'));
  assert.ok(
    !graph.modules.some((module) => module.endsWith('.css')),
    'a stylesheet must not become a graph node',
  );
});

void test('vendored UI modules are part of the analyzed runtime graph', () => {
  const graph = runAudit(PROJECT_ROOT);
  assert.ok(
    graph.modules.some((module) => module.startsWith('components/ui/')),
    'components/ui must be analyzed because owned modules import it and it imports owned modules',
  );
  const outgoing = graph.runtimeEdges.filter(
    (edge) =>
      edge.from.startsWith('components/ui/') &&
      !edge.to.startsWith('components/ui/'),
  );
  assert.ok(
    outgoing.length > 0,
    'components/ui imports owned modules, so it is not a graph leaf',
  );
});

void test('the fingerprint changes when an analyzed module changes and ignores the report', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'am-dep-print-'));
  await writeFile(path.join(directory, 'a.ts'), 'export const a = 1;\n');
  const options = { projectRoot: directory, sourceRoots: ['.'] };
  const before = analyzeRuntimeDependencies(options).inputFingerprint;

  await writeFile(path.join(directory, 'notes.md'), '# not analyzed\n');
  assert.equal(
    analyzeRuntimeDependencies(options).inputFingerprint,
    before,
    'a non-analyzed file must not move the fingerprint',
  );

  await writeFile(path.join(directory, 'a.ts'), 'export const a = 2;\n');
  assert.notEqual(
    analyzeRuntimeDependencies(options).inputFingerprint,
    before,
    'changing an analyzed module must move the fingerprint',
  );
  await rm(directory, { recursive: true, force: true });
});
