import type { TaskDecompositionHarnessResult } from './harness.ts';

export function renderTaskDecompositionSummaryMarkdown(
  result: TaskDecompositionHarnessResult,
) {
  if (result.outcome === 'proposal') {
    const candidates = result.candidates
      .map((candidate) => `- ${candidate.title}: ${candidate.summary}`)
      .join('\n');
    const recomposition = result.recomposition
      ? `\n\nRecomposed the selected working set with ${result.recomposition.effects.length} explicit effects.`
      : '';
    return `# Proposal\n\nProposed ${result.candidates.length} Candidate boundaries.${recomposition}\n\n${candidates}\n`;
  }
  if (result.outcome === 'clarification')
    return `# Clarification\n\n${result.clarification.question}\n`;
  if (result.outcome === 'insufficient-evidence')
    return `# More evidence needed\n\n${result.missingEvidence.map((item) => `- ${item}`).join('\n')}\n`;
  return `# No change\n\n${result.reason}\n`;
}

export function renderTaskDecompositionResponseMarkdown(
  result: TaskDecompositionHarnessResult,
) {
  const impact = result.impactReview?.notes?.length
    ? result.impactReview.notes.map((note) => `- ${note}`).join('\n')
    : '- No additional graph impact was reported.';
  if (result.outcome === 'proposal') {
    const candidates = result.candidates
      .map(
        (candidate) =>
          `## ${candidate.title}\n\n${candidate.summary}\n\n- Derived from: ${candidate.derivedFrom.join(', ')}\n- Depends on: ${candidate.dependsOn.join(', ') || 'None'}`,
      )
      .join('\n\n');
    const effects = result.recomposition
      ? `\n\n## Working-set changes\n\n${result.recomposition.effects
          .map(
            (effect) =>
              `- **${effect.kind}**: ${effect.from.join(', ') || 'None'} → ${effect.to.join(', ') || 'None'}`,
          )
          .join('\n')}`
      : '';
    return `# Decomposition Response\n\nProposed ${result.candidates.length} Candidate boundaries for review.${effects}\n\n## Impact review\n\n${impact}\n\n# Candidate Proposals\n\n${candidates || '_No new Candidate output._'}\n`;
  }
  if (result.outcome === 'clarification') {
    const options = result.clarification.options
      .map(
        (option) =>
          `- **${option.label}**${option.recommended ? ' — Recommended' : ''}: ${option.effect}`,
      )
      .join('\n');
    return `# Decomposition Response\n\n## Clarification\n\n${result.clarification.question}\n\n${options}\n\n## Impact review\n\n${impact}\n`;
  }
  if (result.outcome === 'insufficient-evidence')
    return `# Decomposition Response\n\n## More evidence needed\n\n${result.missingEvidence.map((item) => `- ${item}`).join('\n')}\n\n## Impact review\n\n${impact}\n`;
  return `# Decomposition Response\n\n## No new boundary found\n\n${result.reason}\n\n## Impact review\n\n${impact}\n`;
}
