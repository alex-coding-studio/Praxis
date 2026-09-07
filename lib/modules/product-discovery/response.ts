import type { WhatsNextHarnessResult } from './harness-result.ts';

export function renderWhatsNextResponseMarkdown(
  result: WhatsNextHarnessResult,
) {
  const reflection = result.reflection.markdown.trim();
  const nextStep = renderNextStep(result.reflection.continuationAdvice);
  if (result.outcome === 'proposal') {
    const candidates = result.candidates
      .map((candidate) => demoteHeadings(candidate.outputMarkdown.trim()))
      .join('\n\n---\n\n');
    return `${reflection}

${nextStep}

# Candidate Proposals

${candidates}
`;
  }
  if (result.outcome === 'clarification') {
    const options = result.clarification.options
      .map(
        (option) =>
          `- **${option.label}**${option.recommended ? ' — Recommended' : ''}: ${option.effect}`,
      )
      .join('\n');
    return `${reflection}

${nextStep}

# Clarification

${result.clarification.question}

${options}
`;
  }
  return `${reflection}

${nextStep}

# No further direction

${result.reason}
`;
}

export function renderWhatsNextSummaryMarkdown(result: WhatsNextHarnessResult) {
  return `${result.reflection.markdown.trim()}\n\n${renderNextStep(result.reflection.continuationAdvice)}`;
}

function renderNextStep(
  advice: WhatsNextHarnessResult['reflection']['continuationAdvice'],
) {
  const labels = {
    clarify: 'Clarify the blocking uncertainty',
    concretize: 'Make this direction one level more concrete',
    expand: 'Explore adjacent meaning at this level',
    compare: 'Compare the current directions',
    close: 'Consider closing this line of inquiry',
  } as const;
  return `## Suggested next step

> **${labels[advice.recommendedFocus]}**
>
> ${advice.reason}`;
}

function demoteHeadings(markdown: string) {
  return markdown.replace(/^(#{1,5})\s/gm, '#$1 ');
}
