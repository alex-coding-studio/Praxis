# Card Host Operations

Praxis owns deterministic environment, candidate publication and validation work.
Agents consume structured facts and results instead of reproducing Git, GitHub and CI setup
in model turns.

## Environment Manifest

`scripts/prepare-card-environment.ts` reads one JSON request from stdin or a named file. It
verifies the recorded Card worktree, branch, HEAD, clean state, remote, default branch,
local commit author and role policy. Repeating the request preserves the environment ID.
A deliberate Card workspace restart increments its revision.

The execution service writes the same manifest below the Card planning store and includes it
in Coordinator and Worker packets. These are Host-verified facts. Agents investigate them
only after a concrete contradiction.

## Candidate publication

`scripts/publish-execution-candidate.ts` is the only Candidate publication entrypoint. It
accepts one Action Candidate, not one request per commit. Before starting the script, the
Host serializes publication across Codex, Claude and DeepSeek Workers. The script validates
the complete base-to-head range, clean Card worktree and forbidden paths; selects and
verifies the required bot identity; initializes a missing private repository; pushes the
Action-scoped branch; and creates or updates that Action's Draft PR. It restores the caller's
GitHub account after success or failure. Repeating the same Action and HEAD is idempotent.

Codex, Claude and DeepSeek Workers receive the same operation as `publish_candidate`. A
Worker may make several local commits, then call the Host once. It does not run individual
account, permission, push, PR-create or PR-query commands.

## System validation

`scripts/run-system-validation.ts` runs a configured command against an exact clean
Candidate HEAD. Its cache key includes the candidate SHA, validation profile and environment
fingerprint. Repeating the same request returns the stored result without rerunning the
process. A resource lock prevents overlapping jobs such as two iOS Simulator runs.

Required code gates use `blocking: true`. Optional UI regression uses `blocking: false` and
does not change code acceptance or user UI acceptance. One failed optional run can produce a
single bounded Fix Packet. A later repair commit is a new Candidate SHA and therefore gets a
new cache entry.

All three scripts are thin JSON CLI adapters over the `lib` Host services. They contain no
project, Xcode, Swift or test-target names.
