/** Each tree node owns this runner; cancelled or superseded responses cannot publish UI state. */
export function createLatestFileListing<T>() {
  let generation = 0;
  let controller: AbortController | null = null;
  const cancel = () => {
    generation += 1;
    controller?.abort();
    controller = null;
  };
  return {
    cancel,
    get pending() { return controller !== null; },
    async run(
      load: (signal: AbortSignal) => Promise<T>,
      handlers: { start(): void; success(value: T): void; error(error: unknown): void; finish(): void },
    ): Promise<void> {
      cancel();
      const requestGeneration = generation;
      const requestController = new AbortController();
      controller = requestController;
      const current = () => generation === requestGeneration && !requestController.signal.aborted;
      handlers.start();
      try {
        const value = await load(requestController.signal);
        if (current()) handlers.success(value);
      } catch (error) {
        if (current()) handlers.error(error);
      } finally {
        if (current()) {
          controller = null;
          handlers.finish();
        }
      }
    },
  };
}
