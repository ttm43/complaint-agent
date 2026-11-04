/** Promises keyed by name, resolved later by a callback (RPA result, n8n step result). */
export class Waiters<T> {
  private readonly pending = new Map<string, { resolve: (v: T) => void; timer: ReturnType<typeof setTimeout> }>();

  wait(key: string, timeoutMs: number, onTimeout: () => T): Promise<T> {
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve(onTimeout());
      }, timeoutMs);
      this.pending.set(key, { resolve, timer });
    });
  }

  /** Returns false when nobody was waiting (late or duplicate callback). */
  resolve(key: string, value: T): boolean {
    const p = this.pending.get(key);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(key);
    p.resolve(value);
    return true;
  }
}
