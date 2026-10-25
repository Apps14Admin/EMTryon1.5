/**
 * APPROVAL SYNC — keeps the reviewer's Approve button honest with the Library.
 *
 * A render is posted to the Library the moment it exists, but that save is
 * asynchronous (a thumbnail is rasterised first). The reviewer can press
 * Approve in the compare popup before the record has landed, and a PATCH sent
 * then would 404. This module remembers each save in flight and lets every
 * approval flip wait for it — and applies flips for one record in the order
 * they were made, so the Library ends up showing the button's final state.
 */

export interface ApprovalSync {
  /** Remember a save in flight, so a flip for this id waits for it to land. */
  track(id: string, save: Promise<unknown>): void;
  /**
   * Set the stored record's approval. Resolves once the Library has it.
   * Rejects when the save failed (nothing to approve) or the patch did.
   */
  set(id: string, approved: boolean): Promise<void>;
}

export const createApprovalSync = (
  patch: (id: string, approved: boolean) => Promise<unknown>
): ApprovalSync => {
  const saves = new Map<string, Promise<boolean>>();
  const chains = new Map<string, Promise<unknown>>();

  return {
    track(id, save) {
      // Settle to a flag rather than propagate: the save's own failure is
      // reported where it happened, and an unhandled rejection here would
      // only add noise.
      saves.set(id, save.then(() => true, () => false));
    },

    set(id, approved) {
      const previous = chains.get(id) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          const landed = await (saves.get(id) ?? Promise.resolve(true));
          if (!landed) throw new Error('This render was never saved to the Library, so it cannot be approved there.');
          await patch(id, approved);
        });
      chains.set(id, next);
      return next;
    },
  };
};
