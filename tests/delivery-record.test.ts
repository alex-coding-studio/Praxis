import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createDeliveryRecord,
  readDeliveryRecord,
  updateDeliveryRecord,
} from '../lib/modules/delivery/storage.ts';
import { deliveryCandidateReady } from '../lib/modules/delivery/record.ts';
import { ensureDeliveryArtifacts } from '../lib/modules/delivery/artifacts.ts';
import { resolveProductContextResource } from '../lib/modules/product-context/resource.ts';
import type { RegisteredProject } from '../lib/project-registry.ts';
import type {
  DeliverySource,
  DeliveryModels,
} from '../lib/modules/delivery/types.ts';

const source: DeliverySource = {
  sourceUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceId: 'NODE-aaaaaaaa',
  sourceKind: 'mvp',
  sourceModule: 'whats-next',
  title: 'Example',
  summary: '',
  dependsOn: [],
  outputPaths: [],
  sourceFingerprint: 'source-v1',
};
const models: DeliveryModels = {
  orchestrator: { agent: 'codex', model: '', effort: '' },
  workers: [],
  reviewers: [],
};

async function fixture(t: test.TestContext) {
  const planningPath = await mkdtemp(
    path.join(os.tmpdir(), 'delivery-record-'),
  );
  t.after(() => rm(planningPath, { recursive: true, force: true }));
  return { id: 'fixture', planningPath } as RegisteredProject;
}

void test('concurrent preparation of one source creates a single record and stale user edits cannot overwrite it', async (t) => {
  const project = await fixture(t);
  await Promise.all([
    createDeliveryRecord(project, source, models),
    createDeliveryRecord(project, source, models),
  ]);
  await updateDeliveryRecord(
    project,
    source.sourceUid,
    (record) => {
      record.instructions = 'New user input';
    },
    0,
  );
  await assert.rejects(
    () =>
      updateDeliveryRecord(
        project,
        source.sourceUid,
        (record) => {
          record.instructions = 'Old input';
        },
        0,
      ),
    /Refresh/,
  );
  assert.equal(
    (await readDeliveryRecord(project, source.sourceUid))?.instructions,
    'New user input',
  );
});

void test('merge eligibility accepts a justified review skip and rejects stale checks or missing independent review', async (t) => {
  const project = await fixture(t);
  const record = await createDeliveryRecord(project, source, models);
  record.brief = {
    revision: 1,
    outcome: 'Deliver',
    included: [],
    excluded: [],
    openDecisions: [],
    confirmedAt: 'now',
    criteria: [{ id: 'AC1', description: 'Works', verification: 'unit' }],
  };
  record.publication = {
    url: 'https://example.test/pull/1',
    number: 1,
    head: 'abc',
    state: 'OPEN',
    draft: true,
  };
  record.checks = [
    { id: 'AC1', head: 'abc', status: 'passed', evidence: 'unit-test-log' },
  ];
  record.review = {
    head: 'abc',
    disposition: 'not-required',
    reason: 'Local verified presentation change',
    approved: false,
    reviewerSessionId: null,
  };
  assert.equal(deliveryCandidateReady(record, 'abc'), true);
  assert.equal(deliveryCandidateReady(record, 'new-head'), false);
  record.review.disposition = 'required';
  assert.equal(deliveryCandidateReady(record, 'abc'), false);
  record.review.approved = true;
  record.review.reviewerSessionId = 'independent';
  assert.equal(deliveryCandidateReady(record, 'abc'), true);
  record.checks[0].head = 'old';
  assert.equal(deliveryCandidateReady(record, 'abc'), false);
});

void test('delivery context exposes confirmed scope and accepted evidence, and withdraws a superseded brief', async (t) => {
  const project = await fixture(t);
  await createDeliveryRecord(project, source, models);
  const briefPath = `delivery/targets/${source.sourceUid}/brief.md`;
  const outputPath = `delivery/targets/${source.sourceUid}/output.md`;
  let record = await updateDeliveryRecord(
    project,
    source.sourceUid,
    (current) => {
      current.brief = {
        revision: 1,
        outcome: 'A searchable library',
        included: ['Local search'],
        excluded: ['Cloud search'],
        criteria: [
          {
            id: 'SEARCH',
            description: 'Finds matching titles',
            verification: 'Search unit suite',
          },
        ],
        openDecisions: [],
        confirmedAt: null,
      };
    },
  );
  assert.deepEqual(await ensureDeliveryArtifacts(project, record), []);
  assert.equal(await resolveProductContextResource(project, briefPath), null);
  record = await updateDeliveryRecord(project, source.sourceUid, (current) => {
    current.brief!.confirmedAt = '2026-09-05T00:00:00Z';
  });
  await ensureDeliveryArtifacts(project, record);
  const brief = await resolveProductContextResource(project, briefPath);
  assert.match(brief!.markdown, /Local search/);
  assert.match(brief!.markdown, /Cloud search/);
  assert.match(brief!.markdown, /SEARCH: Finds matching titles/);
  assert.equal(await resolveProductContextResource(project, outputPath), null);
  record = await updateDeliveryRecord(project, source.sourceUid, (current) => {
    current.status = 'completed';
    current.acceptedHead = 'accepted-commit';
    current.checks = [
      {
        id: 'SEARCH',
        head: 'accepted-commit',
        status: 'passed',
        evidence: 'Search unit suite: 6 passed',
      },
    ];
    current.review = {
      head: 'accepted-commit',
      disposition: 'not-required',
      reason: 'Existing implementation verified without changes',
      approved: false,
      reviewerSessionId: null,
    };
  });
  await ensureDeliveryArtifacts(project, record);
  const output = await resolveProductContextResource(project, outputPath);
  assert.match(output!.markdown, /accepted-commit/);
  assert.match(output!.markdown, /Search unit suite: 6 passed/);
  assert.match(
    output!.markdown,
    /Existing implementation verified without changes/,
  );
  await updateDeliveryRecord(project, source.sourceUid, (current) => {
    current.brief!.confirmedAt = null;
    current.status = 'briefing';
  });
  assert.equal(await resolveProductContextResource(project, briefPath), null);
  assert.equal(await resolveProductContextResource(project, outputPath), null);
});
