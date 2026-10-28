// Tree polls share owner revision reads for 1s, including missing owners.
// CLI hooks write markers directly; expiry observes cross-process changes.
// Keep only owners in the latest tree; retry failures on the next poll.
import { revision, type ArtifactContext } from "../artifacts";

export class ArtifactRevisions {
  private readonly owners = new Map<
    string,
    { expires: number; value: Promise<string | null> }
  >();

  constructor(private readonly context: ArtifactContext) {}

  async snapshot(owners: string[]): Promise<Map<string, string | null>> {
    const live = new Set(owners);
    for (const owner of this.owners.keys()) {
      if (!live.has(owner)) this.owners.delete(owner);
    }
    const now = performance.now();
    return new Map(
      await Promise.all(
        owners.map(async (owner) => {
          let entry = this.owners.get(owner);
          if (!entry || now >= entry.expires) {
            const value = revision(this.context, owner);
            entry = { expires: now + 1000, value };
            this.owners.set(owner, entry);
            void value.catch(() => {
              if (this.owners.get(owner)?.value === value)
                this.owners.delete(owner);
            });
          }
          return [owner, await entry.value] as const;
        }),
      ),
    );
  }
}
