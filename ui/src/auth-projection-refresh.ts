export function createAuthProjectionRefresh<T>(
  read: (signal?: AbortSignal) => Promise<T[]>,
  apply: (records: T[]) => void,
) {
  let request = 0;
  let pushes = 0;

  return {
    notePush(): void {
      pushes += 1;
    },
    async refresh(signal?: AbortSignal): Promise<boolean> {
      const revision = ++request;
      const pushesAtStart = pushes;
      const records = await read(signal);
      if (signal?.aborted || revision !== request || pushesAtStart !== pushes) return false;
      apply(records);
      return true;
    },
  };
}
