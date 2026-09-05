import assert from 'node:assert/strict';
import test from 'node:test';
import {
  whatsNextIntentionRegistry,
  whatsNextMotionRegistry,
} from '../lib/modules/product-discovery/intention.ts';
import {
  taskDecompositionIntentionRegistry,
  validateTaskDecompositionIntentionResult,
} from '../lib/modules/scope-decomposition/intention.ts';
import { buildTaskDecompositionPrompt } from '../lib/modules/scope-decomposition/prompt.ts';
import type { TaskDecompositionHarnessResult } from '../lib/modules/scope-decomposition/harness.ts';
import { toScopeDecompositionSemanticResult } from '../lib/modules/scope-decomposition/producer-adapter.ts';
import {
  taskDecompositionMotionRegistry,
  validateTaskDecompositionMotionResult,
} from '../lib/modules/scope-decomposition/motion.ts';

void test('Intention Profile registries are module-scoped', () => {
  assert.deepEqual(
    whatsNextIntentionRegistry.profiles.map((profile) => profile.id),
    ['mvp-exploration', 'feature-synthesis', 'product-design-completion'],
  );
  assert.deepEqual(
    whatsNextMotionRegistry.profiles.map((profile) => profile.id),
    ['unspecified', 'diverge', 'converge'],
  );
  assert.notEqual(
    whatsNextMotionRegistry.profiles[1]?.prompt,
    taskDecompositionMotionRegistry.profiles[1]?.prompt,
  );
  assert.deepEqual(
    taskDecompositionIntentionRegistry.profiles.map((profile) => profile.id),
    ['understanding', 'product-modules', 'implementation-approach', 'delivery'],
  );
  assert.equal(
    taskDecompositionIntentionRegistry.profiles.some(
      (profile) => profile.id === ('mvp-exploration' as never),
    ),
    false,
  );
});

void test('Break It Down composes only its selected Intention Profile', () => {
  const prompt = buildTaskDecompositionPrompt({}, 'delivery');
  assert.match(prompt, /INTENTION PROFILE — Delivery breakdown/);
  assert.doesNotMatch(prompt, /MVP Exploration/);
});

void test('profile validation keeps delivery metadata executable', () => {
  const result = proposal({
    deliverable: 'Persist one searchable Item model.',
    acceptance: ['The Item can be saved and read.'],
    validation: ['Run the Item persistence test.'],
  });
  assert.doesNotThrow(() =>
    validateTaskDecompositionIntentionResult('delivery', result),
  );
  assert.throws(
    () =>
      validateTaskDecompositionIntentionResult(
        'delivery',
        proposal({ deliverable: 'Missing evidence.' }),
      ),
    /requires deliverable, acceptance and validation metadata/,
  );
});

void test('Break It Down owns its Motion profiles and validates their cardinality', () => {
  assert.deepEqual(
    taskDecompositionMotionRegistry.profiles.map((profile) => profile.id),
    ['unspecified', 'diverge', 'converge'],
  );
  const one = proposal({});
  assert.throws(
    () => validateTaskDecompositionMotionResult('diverge', one),
    /at least two/,
  );
  assert.doesNotThrow(() =>
    validateTaskDecompositionMotionResult('converge', one),
  );
});

function proposal(metadata: Record<string, unknown>) {
  return toScopeDecompositionSemanticResult(harnessProposal(metadata));
}

function harnessProposal(
  metadata: Record<string, unknown>,
): TaskDecompositionHarnessResult {
  return {
    schemaVersion: 1,
    harness: {
      id: 'praxis.task-decomposition',
      revision: 8,
    },
    request: {
      sessionId: 'SESSION-test',
      requestId: 'REQUEST-test',
      inputFingerprint: 'fingerprint',
    },
    impactReview: {
      reviewedNodeIds: [],
      affectedNodeIds: [],
      notes: [],
    },
    outcome: 'proposal',
    candidates: [
      {
        uid: '00000000-0000-4000-8000-000000000001',
        relations: { derivedFrom: ['NODE-00000000'], dependsOn: [] },
        candidateId: 'CANDIDATE-a1b2c3d4',
        revision: 1,
        type: 'module',
        title: 'Candidate',
        summary: 'A bounded Candidate.',
        derivedFrom: ['NODE-00000000'],
        dependsOn: [],
        resources: [],
        typeTemplateRef: null,
        metadata,
        presentation: {},
        assumptions: [],
      },
    ],
  };
}
