# Development Delivery

Status: implementation in progress in PR #214. Do not merge or reset live execution data until the remaining rollout work and user UI acceptance are complete.

## Product boundary

The delivery workspace projects accepted Discovery MVPs, formal decomposition tasks and current Delivery Contracts. Source modules retain identity, content and dependency ownership. Product Design and Domain Model are context, not executable targets. Preparing a target creates its independent delivery record; browsing a projection does not.

One target owns a continuing worktree, branch and PR. Its Orchestrator maintains the outcome and delegates bounded work with models selected from user-configured Worker and Reviewer pools. Internal progress items are observation, not independently accepted Actions. Ordinary recovery stays in the same delivery. Independent Review is optional and selected for actual scope and risk; findings must have concrete evidence. User feedback revises the same candidate. The user initiates acceptance and merge.

## Implemented checkpoints

- Source discovery, fingerprints, prerequisite projection and serialized target records.
- Delivery Brief conversation and confirmation, dynamic progress, model pools and module instructions.
- Provider-session execution with Worker delegation, optional Review, exact-commit checks and user feedback.
- Draft publication through the existing serialized Host publisher, user-triggered acceptance and guarded merge, local sync attempt.
- Standalone logs using the existing LogViewer and actor-tagged log format.
- Preview at `/projects/<projectId>/delivery`, using the shared CanvasNodeCardFrame, Composer controls, ContextAttachmentPicker and sticky-header frame.
- Provider fixture regressions for read-only briefing to writable worktree resume, DeepSeek role/access handling, and invalidating checks when the Brief changes.

## Remaining work before rollout

- Finish source-context loading and durable brief/evidence artifacts, cancellation/restart and submission concurrency verification.
- Complete Target header and Canvas response/status integration, workspace opening and source-linked navigation. Keep the shared Composer and context picker unchanged.
- Replace production implementation navigation and Card-based completion/protection consumers with Target records. Remove retired Card/Plan/Action workflows and their obsolete tests after shared utilities have been extracted.
- Implement and verify the scoped one-time Locus execution reset, then run it only after the new flow is ready. Existing source graphs, repository commits and remote PRs remain intact.
- Validate both independent-review and justified-review-skip delivery paths with a real provider, obtain user UI acceptance, then finish final review and publication.

## Validation boundaries

`npm run test:delivery` exercises projection, storage, brief/session continuity, model-pool choice, provider resume and merge eligibility. Existing provider, publication, observability and UI suites remain applicable. Fixture tests prove orchestration mechanics, not model task quality or human visual acceptance. No real Locus execution or destructive reset has been run by this branch yet.
