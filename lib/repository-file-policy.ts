export function includeInGitHistory(file: string) {
  const parts = file.split('/');
  if (
    parts.some((part) =>
      ['.git', '.praxis', '.ssh', '.gnupg', '.DS_Store'].includes(part),
    )
  )
    return false;
  const name = parts.at(-1)!;
  if (
    /^\.env(?:\.|$)/i.test(name) &&
    !/\.(example|sample|template)$/i.test(name)
  )
    return false;
  return !/\.(pem|p12|pfx|key|mobileprovision)$/i.test(name);
}
