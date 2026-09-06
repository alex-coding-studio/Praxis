# Development Delivery

Status: implementation in progress in PR #214. Do not merge or reset live execution data until the remaining rollout work and user UI acceptance are complete.

## Product boundary

The delivery workspace projects accepted Discovery MVPs, formal decomposition tasks and current Delivery Contracts. Source modules retain identity, content and dependency ownership. Product Design and Domain Model are context, not executable targets. Preparing a target creates its independent delivery record; browsing a projection does not.

One target owns a continuing worktree, branch and PR. Its Orchestrator maintains the outcome and delegates bounded work with models selected from user-configured Worker and Reviewer pools. Internal progress items are observation, not independently accepted Actions. Ordinary recovery stays in the same delivery. Independent Review is optional and selected for actual scope and risk; findings must have concrete evidence. User feedback revises the same candidate. The user initiates acceptance and merge.

Before user acceptance, the user can explicitly withdraw the current delivery attempt. The Host stops the Agent and drains outstanding Host operations, closes an open PR, removes only the registered Target worktree and clears active scope, sessions and evidence. Source identity and model settings remain; prior records and logs are retained for investigation. The next confirmed execution creates a new attempt branch/worktree from the latest main. Previously merged code and other Targets are never reverted. Cancellation alone continues to preserve the attempt and its work. Withdrawal requires a destructive-action confirmation and writes a Host log; accepted deliveries cannot be withdrawn.

## Implemented checkpoints

- Source discovery, fingerprints, prerequisite projection and serialized target records.
- Delivery Brief conversation and confirmation, dynamic progress, model pools and module instructions.
- Provider-session execution with Worker delegation, optional Review, exact-commit checks and user feedback.
- Draft publication through the existing serialized Host publisher, user-triggered acceptance and guarded merge, local sync attempt.
- Standalone logs using the existing LogViewer and actor-tagged log format.
- Preview at `/projects/<projectId>/delivery`, using the shared CanvasNodeCardFrame, Composer controls, ContextAttachmentPicker and sticky-header frame.
- Provider fixture regressions for read-only briefing to writable worktree resume, DeepSeek role/access handling, and invalidating checks when the Brief changes.
- User acceptance of verified existing main when a Target is already satisfied, without manufacturing a commit or PR. The Host rechecks current main and the evidence before accepting.
- Confirmed Briefs and accepted delivery evidence exposed through the existing Product Context browser as derived Markdown. The delivery record remains authoritative; superseded unconfirmed scope is not current context.
- Shared Markdown reader for Briefs and responses, including selection feedback into the unchanged Composer. Acceptance actions remain in the Target sticky header.
- New production navigation and source status projections. Old implementation URLs redirect to the Target workspace, and old execution mutation endpoints have been removed.
- Scoped reset command with a non-destructive default: `node --experimental-strip-types scripts/reset-legacy-delivery.ts --project=<id>`. Add `--execute` only at the rollout boundary.

## Remaining work before rollout

- Finish extracting shared publication, path and log utilities from the old implementation module. Remove retired Card/Plan/Action consumers and their obsolete tests at the reset boundary, without deleting graph-module behavior.
- Complete final UI and real-project dogfood before rollout. Keep the shared Composer and context picker unchanged.
- Run the verified one-time Locus execution reset only after the new flow is ready. Existing source graphs, repository commits and remote PRs remain intact.
- Obtain user UI acceptance, complete final exact-head review and repository gates, then publish the final result.

## Validation boundaries

`npm run test:delivery` exercises projection, storage, brief/session continuity, model-pool choice, provider resume, merge eligibility, existing-main acceptance, context artifacts and reset ownership. Existing provider, publication, observability and UI suites remain applicable. Fixture tests prove orchestration mechanics, not model task quality or human visual acceptance.

Two opt-in real-provider smoke scripts have passed in temporary projects. `scripts/smoke-delivery-brief.ts` demonstrated two Brief turns in the same native Codex session. `scripts/smoke-delivery-execution.ts` demonstrated an Astra Orchestrator delegating code and unit checks to a Luna Worker, followed by an independent Luna Reviewer approving the same commit. These scripts incur model usage and are not part of the automatic unit suite. The execution smoke deliberately excludes remote publication; temporary repositories and worktrees are removed afterward.

No real Locus execution, PR merge or destructive reset has been run by this branch yet. Real provider evidence does not substitute for the remaining user-facing rollout and acceptance.
