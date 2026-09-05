import { spawn } from 'node:child_process';
import path from 'node:path';
import type {
  CandidatePublication,
  CandidatePublishRequest,
} from '../card-host-operations.ts';

const publicationRuntime = globalThis as typeof globalThis & {
  praxisCandidatePublicationQueue?: Promise<void>;
};

export function runCandidatePublicationScript(
  request: CandidatePublishRequest,
): Promise<CandidatePublication> {
  return serializeCandidatePublication(() => runScript(request));
}

function runScript(
  request: CandidatePublishRequest,
): Promise<CandidatePublication> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(process.cwd(), 'scripts/publish-execution-candidate.ts'),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errorOutput = (errorOutput + String(chunk)).slice(-16000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(errorOutput.trim() || 'Candidate publication failed.'),
        );
        return;
      }
      try {
        resolve(JSON.parse(output) as CandidatePublication);
      } catch {
        reject(new Error('Candidate publication returned an invalid result.'));
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(request));
  });
}

export function serializeCandidatePublication<T>(
  work: () => Promise<T>,
): Promise<T> {
  const previous =
    publicationRuntime.praxisCandidatePublicationQueue ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  publicationRuntime.praxisCandidatePublicationQueue = previous
    .catch(() => undefined)
    .then(() => current);
  return previous
    .catch(() => undefined)
    .then(work)
    .finally(() => release());
}
