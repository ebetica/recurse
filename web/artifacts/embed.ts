// Document-local artifact preview ids use a per-page sequence.
let frameDescriptionSequence = 0;

export function nextArtifactFrameDescriptionId(): string {
  frameDescriptionSequence += 1;
  return `artifact-frame-description-${frameDescriptionSequence}`;
}
