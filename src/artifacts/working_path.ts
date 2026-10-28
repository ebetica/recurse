// Operator-facing Artifact paths stay portable across instance locations.
export function artifactWorkingPath(owner: string, id: string): string {
  return `$CHAT_DATA_DIR/artifact_repos/${owner}/${id}`;
}
