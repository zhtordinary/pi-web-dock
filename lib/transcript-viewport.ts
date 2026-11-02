import { getLiveFollowAttached } from "./chat-lazy-load";

interface VisibleRow { entryId: string; offset: number }
/** Sole writer of the transcript scroll position, including layout and navigation. */
export class TranscriptViewport {
  follow = true;
  initialized = false;
  private previousScrollTop = 0;
  private anchor: VisibleRow | null = null;
  constructor(private container: () => HTMLElement | null, private changed: (follow: boolean) => void) {}
  setFollow(value: boolean): void { this.follow = value; this.changed(value); }
  private measure(): VisibleRow | null {
    const container = this.container();
    if (!container) return null;
    const top = container.getBoundingClientRect().top;
    for (const row of container.querySelectorAll<HTMLElement>("[data-chat-message-row][data-entry-id]")) {
      if (row.getBoundingClientRect().bottom > top && row.dataset.entryId) return { entryId: row.dataset.entryId, offset: row.getBoundingClientRect().top - top };
    }
    return null;
  }
  onScroll = (): void => {
    const container = this.container();
    if (!container) return;
    this.setFollow(getLiveFollowAttached(this.follow, this.previousScrollTop, container.scrollTop, container.clientHeight, container.scrollHeight));
    this.previousScrollTop = container.scrollTop;
    this.anchor = this.measure();
  };
  private write(top: number, behavior: ScrollBehavior = "auto"): void {
    const container = this.container();
    if (!container) return;
    container.scrollTo({ top: Math.max(0, top), behavior });
    this.previousScrollTop = container.scrollTop;
    this.anchor = this.measure();
  }
  scrollToBottom = (behavior: ScrollBehavior = "auto", follow = true): void => {
    this.initialized = true; this.setFollow(follow);
    this.write(this.container()?.scrollHeight ?? 0, behavior);
  };
  scrollToEntry = (element: HTMLElement, offset = 16, follow = false): void => {
    const container = this.container();
    if (!container || !element.isConnected) return;
    this.initialized = true; this.setFollow(follow);
    this.write(container.scrollTop + element.getBoundingClientRect().top - container.getBoundingClientRect().top - offset);
  };
  commit(publish: () => void): void {
    const anchor = this.measure();
    publish();
    this.restore(anchor);
  }
  private restore(anchor: VisibleRow | null): void {
    const container = this.container();
    if (!container || !this.initialized) return;
    if (this.follow) this.write(container.scrollHeight);
    else if (anchor) {
      const row = [...container.querySelectorAll<HTMLElement>("[data-chat-message-row][data-entry-id]")].find(row => row.dataset.entryId === anchor.entryId);
      if (row) this.write(container.scrollTop + row.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset);
    }
    this.anchor = this.measure();
  }
  resize = (): void => { this.restore(this.anchor); };
}
