import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { RegisteredProject } from '../lib/project-registry.ts';
import {
  collectWhatToDoRepositoryFacts,
  readWhatToDoRepositoryEvidence,
  readWhatToDoTargetedRepositoryEvidence,
} from '../lib/modules/delivery-planning/repository-facts.ts';

const execute = promisify(execFile);

void test('automatic evidence skips binary contents while preserving text and file inventory', async (t) => {
  const { project, rootPath } = await fixture(t);
  await mkdir(path.join(rootPath, 'docs'));
  await writeFile(path.join(rootPath, 'docs/design.html'), '<h1>设计规范</h1>');
  await writeFile(
    path.join(rootPath, 'docs/NOTES'),
    'Plain text without an extension',
  );
  await writeFile(
    path.join(rootPath, 'docs/image.png'),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  await writeFile(
    path.join(rootPath, 'docs/.thumbnail'),
    Buffer.from([0, 1, 2, 3]),
  );
  await writeFile(
    path.join(rootPath, 'docs/legacy.md'),
    Buffer.from([255, 254, 65, 0]),
  );
  const facts = await collectWhatToDoRepositoryFacts(project);
  assert.equal(facts.observedFileCount, 5);
  assert.ok(facts.paths.documentation.includes('docs/image.png'));
  const evidence = await readWhatToDoRepositoryEvidence(project, facts);
  assert.deepEqual(evidence.map((entry) => entry.path).sort(), [
    'docs/NOTES',
    'docs/design.html',
  ]);
  assert.equal(
    evidence.find((entry) => entry.path === 'docs/design.html')?.content,
    '<h1>设计规范</h1>',
  );
  await assert.rejects(
    readWhatToDoTargetedRepositoryEvidence(project, facts, ['docs/image.png']),
    /Images and other binary files/,
  );
  await writeFile(path.join(rootPath, 'docs/design.html'), '<h1>Changed</h1>');
  await assert.rejects(
    readWhatToDoRepositoryEvidence(project, facts),
    /evidence changed/,
  );
});

async function fixture(t: test.TestContext) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'repository-facts-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const project: RegisteredProject = {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'repository',
    name: 'Fixture',
    description: '',
    rootPath,
    codePath: rootPath,
    planningPath: path.join(rootPath, '.praxis'),
    createdAt: '2026-09-02T00:00:00.000Z',
  };
  return { project, rootPath };
}

async function git(root: string, ...args: string[]) {
  return execute('git', ['-C', root, ...args], { encoding: 'utf8' });
}

void test('Repository Facts describe observed project evidence without inferring a framework', async (t) => {
  const { project, rootPath } = await fixture(t);
  await mkdir(path.join(rootPath, 'src'));
  await mkdir(path.join(rootPath, '.praxis'));
  await mkdir(path.join(rootPath, 'node_modules'));
  await writeFile(
    path.join(rootPath, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test', build: 'next build' } }),
  );
  await writeFile(path.join(rootPath, 'README.md'), '# Fixture\n');
  await writeFile(
    path.join(rootPath, 'src/index.ts'),
    'export const value = 1;\n',
  );
  await writeFile(path.join(rootPath, '.praxis/private.md'), 'private\n');
  await writeFile(path.join(rootPath, 'node_modules/ignored.js'), 'ignored\n');
  await git(rootPath, 'init', '--initial-branch=main');
  await git(rootPath, 'config', 'user.name', 'Fixture');
  await git(rootPath, 'config', 'user.email', 'fixture@example.com');
  await writeFile(
    path.join(rootPath, '.gitignore'),
    'node_modules/\ncredentials.json\n',
  );
  await writeFile(
    path.join(rootPath, 'credentials.json'),
    '{"TOKEN":"secret"}\n',
  );
  await writeFile(
    path.join(rootPath, '.git/info/exclude'),
    '# git ls-files --others --exclude-from=.git/info/exclude\n.praxis/\n',
  );
  await git(
    rootPath,
    'add',
    '.gitignore',
    'package.json',
    'README.md',
    'src/index.ts',
  );
  await git(rootPath, 'commit', '-m', 'fixture');

  const first = await collectWhatToDoRepositoryFacts(project);
  const second = await collectWhatToDoRepositoryFacts(project);
  assert.equal(first.git?.branch, 'main');
  assert.equal(first.git?.objectFormat, 'sha1');
  assert.match(first.git?.head ?? '', /^[0-9a-f]{40}$/);
  assert.equal(first.git?.dirty, false);
  assert.equal(first.containsSourceMaterial, true);
  assert.deepEqual(first.extensions, {
    '.json': 1,
    '.md': 1,
    '.ts': 1,
    '[none]': 1,
  });
  assert.deepEqual(first.paths.manifests, ['package.json']);
  assert.deepEqual(first.paths.documentation, ['README.md']);
  assert.deepEqual(first.packageScripts, {
    build: 'next build',
    test: 'node --test',
  });
  assert.equal(first.evidence.length, 2);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.reusable, true);
  assert.equal(JSON.stringify(first).includes('framework'), false);
  assert.equal(JSON.stringify(first).includes('ignored.js'), false);
  assert.equal(JSON.stringify(first).includes('private.md'), false);
  await assert.rejects(
    readWhatToDoTargetedRepositoryEvidence(project, first, [
      'credentials.json',
    ]),
    /not in the Git inventory/,
  );

  await writeFile(path.join(rootPath, 'README.md'), '# Changed\n');
  const changed = await collectWhatToDoRepositoryFacts(project);
  assert.equal(changed.git?.dirty, true);
  assert.notEqual(changed.git?.dirtyFingerprint, first.git?.dirtyFingerprint);
  assert.notEqual(changed.fingerprint, first.fingerprint);

  await rm(path.join(rootPath, 'README.md'));
  const deleted = await collectWhatToDoRepositoryFacts(project);
  assert.deepEqual(deleted.paths.documentation, []);
});

void test('Repository Facts support an empty non-Git project', async (t) => {
  const { project } = await fixture(t);
  const facts = await collectWhatToDoRepositoryFacts(project);
  assert.equal(facts.git, null);
  assert.equal(facts.containsSourceMaterial, false);
  assert.equal(facts.observedFileCount, 0);
  assert.deepEqual(facts.topLevel, []);
  assert.deepEqual(facts.extensions, {});
  assert.match(facts.fingerprint, /^[0-9a-f]{64}$/);
});

void test('an empty Git repository keeps Git ignore authoritative', async (t) => {
  const { project, rootPath } = await fixture(t);
  await git(rootPath, 'init', '--initial-branch=main');
  await writeFile(path.join(rootPath, '.git/info/exclude'), 'package.json\n');
  await writeFile(
    path.join(rootPath, 'package.json'),
    JSON.stringify({ scripts: { leak: 'TOKEN=secret command' } }),
  );
  const facts = await collectWhatToDoRepositoryFacts(project);
  assert.equal(facts.git?.head, null);
  assert.equal(facts.containsSourceMaterial, false);
  assert.equal(facts.observedFileCount, 0);
  assert.deepEqual(facts.paths.manifests, []);
  assert.deepEqual(facts.packageScripts, {});
  assert.equal(JSON.stringify(facts).includes('TOKEN=secret'), false);
});

void test('SHA-256 HEAD changes refresh an otherwise stable clean snapshot', async (t) => {
  const { project, rootPath } = await fixture(t);
  try {
    await git(
      rootPath,
      'init',
      '--object-format=sha256',
      '--initial-branch=main',
    );
  } catch {
    t.skip('Git does not support SHA-256 repositories.');
    return;
  }
  await git(rootPath, 'config', 'user.name', 'Fixture');
  await git(rootPath, 'config', 'user.email', 'fixture@example.com');
  await writeFile(
    path.join(rootPath, 'source.ts'),
    'export const value = 1;\n',
  );
  await git(rootPath, 'add', 'source.ts');
  await git(rootPath, 'commit', '-m', 'first');
  const first = await collectWhatToDoRepositoryFacts(project);
  await writeFile(
    path.join(rootPath, 'source.ts'),
    'export const value = 2;\n',
  );
  await git(rootPath, 'add', 'source.ts');
  await git(rootPath, 'commit', '-m', 'second');
  const second = await collectWhatToDoRepositoryFacts(project);
  assert.equal(first.git?.objectFormat, 'sha256');
  assert.match(first.git?.head ?? '', /^[0-9a-f]{64}$/);
  assert.match(second.git?.head ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(second.git?.head, first.git?.head);
  assert.notEqual(second.fingerprint, first.fingerprint);
});

void test('truncated dirty evidence is explicitly non-reusable across same-size rewrites', async (t) => {
  const { project, rootPath } = await fixture(t);
  await git(rootPath, 'init', '--initial-branch=main');
  await writeFile(
    path.join(rootPath, 'large.bin'),
    Buffer.alloc(33 * 1024 * 1024, 1),
  );
  const first = await collectWhatToDoRepositoryFacts(project);
  await writeFile(
    path.join(rootPath, 'large.bin'),
    Buffer.alloc(33 * 1024 * 1024, 2),
  );
  const second = await collectWhatToDoRepositoryFacts(project);
  assert.equal(first.git?.dirtyFingerprintTruncated, true);
  assert.equal(second.git?.dirtyFingerprintTruncated, true);
  assert.equal(first.reusable, false);
  assert.equal(second.reusable, false);
});

void test('top-level inventory has an explicit bound', async (t) => {
  const { project, rootPath } = await fixture(t);
  const names = Array.from(
    { length: 205 },
    (_, index) => `source-${String(index).padStart(3, '0')}.ts`,
  );
  for (const name of [...names].reverse())
    await writeFile(path.join(rootPath, name), '');
  const reverseCreation = await collectWhatToDoRepositoryFacts(project);
  for (const name of names) await rm(path.join(rootPath, name));
  for (const name of names) await writeFile(path.join(rootPath, name), '');
  const forwardCreation = await collectWhatToDoRepositoryFacts(project);
  const expected = names.slice(0, 200);
  assert.deepEqual(
    reverseCreation.topLevel.map((entry) => entry.name),
    expected,
  );
  assert.deepEqual(
    forwardCreation.topLevel.map((entry) => entry.name),
    expected,
  );
  assert.equal(reverseCreation.topLevelTruncated, true);
  assert.equal(forwardCreation.topLevelTruncated, true);
  assert.equal(reverseCreation.reusable, false);
  assert.equal(forwardCreation.reusable, false);
});

void test('more than 200 dirty paths makes the snapshot non-reusable', async (t) => {
  const { project, rootPath } = await fixture(t);
  await git(rootPath, 'init', '--initial-branch=main');
  await mkdir(path.join(rootPath, 'changes'));
  await Promise.all(
    Array.from({ length: 201 }, (_, index) =>
      writeFile(path.join(rootPath, 'changes', `${index}.txt`), 'changed\n'),
    ),
  );
  const facts = await collectWhatToDoRepositoryFacts(project);
  assert.equal(facts.git?.dirtyFingerprintTruncated, true);
  assert.equal(facts.reusable, false);
});
