import { describe, it, expect, vi } from 'vitest';
import { createApprovalSync } from './libraryApproval';

/** A promise whose settlement the test controls. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createApprovalSync', () => {
  it('waits for the tracked save to land before patching the record', async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const sync = createApprovalSync(patch);
    const save = deferred<void>();
    sync.track('gen-1', save.promise);

    const done = sync.set('gen-1', true);
    await tick();
    expect(patch).not.toHaveBeenCalled();

    save.resolve();
    await done;
    expect(patch).toHaveBeenCalledWith('gen-1', true);
  });

  it('patches at once when nothing is tracked for the id', async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const sync = createApprovalSync(patch);
    await sync.set('gen-2', false);
    expect(patch).toHaveBeenCalledWith('gen-2', false);
  });

  it('rejects without a request when the save itself failed', async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const sync = createApprovalSync(patch);
    const save = deferred<void>();
    sync.track('gen-3', save.promise);
    save.reject(new Error('boom'));

    await expect(sync.set('gen-3', true)).rejects.toThrow(/never saved/i);
    expect(patch).not.toHaveBeenCalled();
  });

  it('applies flips for one id in the order they were made', async () => {
    const order: boolean[] = [];
    const gates: Array<() => void> = [];
    const patch = vi.fn((_id: string, approved: boolean) =>
      new Promise<void>((resolve) => {
        gates.push(() => {
          order.push(approved);
          resolve();
        });
      })
    );
    const sync = createApprovalSync(patch);

    const first = sync.set('gen-4', true);
    const second = sync.set('gen-4', false);
    await tick();
    // The second flip has not been sent while the first is in flight.
    expect(patch).toHaveBeenCalledTimes(1);

    gates[0]();
    await first;
    await tick();
    expect(patch).toHaveBeenCalledTimes(2);
    gates[1]();
    await second;
    expect(order).toEqual([true, false]);
  });

  it('surfaces the patch failure to the caller', async () => {
    const patch = vi.fn().mockRejectedValue(new Error('No such generation'));
    const sync = createApprovalSync(patch);
    await expect(sync.set('gen-5', true)).rejects.toThrow('No such generation');
  });
});
