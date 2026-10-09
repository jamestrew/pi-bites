const dialogTails = new WeakMap<object, Promise<void>>();

/** Serialize the actual dialog lifetime, even if its caller stops waiting. */
export function withApprovalDialog<T>(
  owner: object,
  signal: AbortSignal | undefined,
  show: () => Promise<T>,
): Promise<T> {
  const previous = dialogTails.get(owner) ?? Promise.resolve();
  const result = previous.then(() => {
    signal?.throwIfAborted();
    return show();
  });
  const tail = result.then(
    () => {},
    () => {},
  );
  dialogTails.set(owner, tail);
  void tail.then(() => {
    if (dialogTails.get(owner) === tail) dialogTails.delete(owner);
  });
  return result;
}
