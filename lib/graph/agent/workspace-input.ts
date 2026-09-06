export type ContextWorkspaceAttachment = {
  originalName: string;
  mediaType: string;
  byteSize: number;
  semanticKind: string;
};

export type ContextWorkspaceInput = {
  role: 'primary' | 'related';
  kind: string;
  logicalPath: string;
  content: string;
  nodeId?: string;
  attachment?: ContextWorkspaceAttachment;
};

export function userInputWorkspaceInput(
  logicalPath: string,
  value: string,
): ContextWorkspaceInput | null {
  const text = value.trim();
  if (!text) return null;
  return {
    role: 'primary',
    kind: 'user-input',
    logicalPath,
    content: `# User Input\n\n${text}\n`,
  };
}
