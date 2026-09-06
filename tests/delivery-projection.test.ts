import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDeliveryTargets } from '../lib/modules/delivery/projection.ts';
import type { DeliverySource } from '../lib/modules/delivery/types.ts';
import { nodeDeliveryKind } from '../lib/modules/delivery/sources.ts';
import type { TaskGraphNode } from '../lib/graph/task/nodes.ts';

function source(uid: string, dependsOn: string[] = []): DeliverySource {
  return {
    sourceKind: 'mvp',
    sourceModule: 'whats-next',
    sourceId: `NODE-${uid}`,
    sourceUid: uid,
    title: uid,
    summary: '',
    dependsOn,
    outputPaths: [],
    sourceFingerprint: `fingerprint-${uid}`,
  };
}

void test('only accepted MVPs and formal task nodes become executable sources', () => {
  const node = {
    role: 'node',
    status: 'accepted',
    layer: 'discovery',
    artifactKind: 'mvp',
  } as TaskGraphNode;
  assert.equal(nodeDeliveryKind(node, 'whats-next'), 'mvp');
  assert.equal(
    nodeDeliveryKind(
      { ...node, layer: 'product-design', artifactKind: 'feature' },
      'whats-next',
    ),
    null,
  );
  assert.equal(
    nodeDeliveryKind({ ...node, artifactKind: 'direction' }, 'whats-next'),
    null,
  );
  assert.equal(
    nodeDeliveryKind({ ...node, status: 'proposed' }, 'whats-next'),
    null,
  );
  assert.equal(
    nodeDeliveryKind({ ...node, role: 'start' }, 'task-graph'),
    null,
  );
  assert.equal(
    nodeDeliveryKind({ ...node, artifactKind: undefined }, 'task-graph'),
    'task',
  );
});

void test('projection discovers targets without creating execution records and resolves cross-layer prerequisites', () => {
  const inputs = [
    source('first'),
    {
      ...source('second', ['first']),
      sourceKind: 'task' as const,
      sourceModule: 'task-graph' as const,
    },
  ];
  const initial = projectDeliveryTargets(inputs, [], new Set());
  assert.equal(initial[0].status, 'ready');
  assert.equal(initial[0].delivery, null);
  assert.equal(initial[1].status, 'waiting');
  assert.deepEqual(initial[1].unmetDependencies, ['first']);
  const completed = projectDeliveryTargets(
    inputs,
    [
      {
        sourceUid: 'first',
        sourceFingerprint: 'fingerprint-first',
        status: 'completed',
      },
    ],
    new Set(),
  );
  assert.equal(completed[1].status, 'ready');
});

void test('formal context satisfies a context dependency but absent and cyclic prerequisites never unlock', () => {
  const targets = projectDeliveryTargets(
    [
      source('context-user', ['feature']),
      source('missing', ['absent']),
      source('cycle-a', ['cycle-b']),
      source('cycle-b', ['cycle-a']),
    ],
    [],
    new Set(['feature']),
  );
  assert.equal(targets[0].status, 'ready');
  assert.equal(targets[1].status, 'waiting');
  assert.equal(targets[2].status, 'waiting');
  assert.equal(targets[3].status, 'waiting');
});

void test('changed source preserves an existing delivery while refusing to reuse its completed evidence', () => {
  const targets = projectDeliveryTargets(
    [source('first'), source('second', ['first'])],
    [{ sourceUid: 'first', sourceFingerprint: 'older', status: 'completed' }],
    new Set(),
  );
  assert.equal(targets[0].sourceChanged, true);
  assert.equal(targets[0].delivery?.status, 'completed');
  assert.equal(targets[0].status, 'warning');
  assert.equal(targets[1].status, 'waiting');
});
