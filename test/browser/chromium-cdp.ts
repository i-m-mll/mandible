import WebSocket from 'ws';

export type CdpClient = {
  call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, any>>;
  close: () => void;
};

export async function connectCdp(url: string, fixture: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => {
      socket.close();
      rejectOpen(new Error(`Timed out opening the ${fixture} DevTools websocket.`));
    }, 5_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolveOpen();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      rejectOpen(new Error(`${fixture} DevTools websocket failed to open.`));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: (reason: Error) => void }>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; error?: { message: string }; result?: Record<string, any> };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result ?? {});
  });

  return {
    call: (method, params = {}) => new Promise((resolveCall, rejectCall) => {
      const id = nextId++;
      pending.set(id, { resolve: resolveCall, reject: rejectCall });
      socket.send(JSON.stringify({ id, method, params }));
    }),
    close: () => socket.close(),
  };
}

export async function waitFor<T>(stage: string, read: () => T | null | Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${stage} after ${timeoutMs}ms.`);
}
