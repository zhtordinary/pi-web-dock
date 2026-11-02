/** Revision belongs to the top-level owner. Child-local edits are intents. */
export class FilterAuthorityCursor {
  private epoch: string | null = null;
  private revision = -1;
  private retired = new Set<string>();

  accept(epoch: string, revision: number, initial = false): boolean {
    if (!epoch || !Number.isSafeInteger(revision) || revision < 0 || this.retired.has(epoch)) return false;
    if (this.epoch !== epoch) {
      if (this.epoch !== null && !initial) return false;
      if (this.epoch !== null) this.retired.add(this.epoch);
      this.epoch = epoch;
      this.revision = -1;
    }
    if (revision <= this.revision) return false;
    this.revision = revision;
    return true;
  }
}
