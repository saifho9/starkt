// الطلبات المتزامنة لنفس العنصر تنتظر بعضها؛ العناصر المختلفة لا تتعطل.
export function createSerialQueue() {
  const pending = new Map();
  return async function serialize(key, task) {
    const previous = pending.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    pending.set(key, current);
    try { return await current; }
    finally { if (pending.get(key) === current) pending.delete(key); }
  };
}
