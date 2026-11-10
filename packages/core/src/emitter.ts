// Minimal typed event emitter, so the core doesn't depend on Node's "events" module.

export class Emitter<E extends { [K in keyof E]: (...args: any[]) => void }> {
  private listeners: { [K in keyof E]?: E[K][] } = {};

  on<K extends keyof E>(event: K, fn: E[K]): () => void {
    (this.listeners[event] ??= []).push(fn);
    return () => this.off(event, fn);
  }

  off<K extends keyof E>(event: K, fn: E[K]) {
    const list = this.listeners[event];
    if (list) this.listeners[event] = list.filter((f) => f !== fn);
  }

  protected emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>) {
    for (const fn of [...(this.listeners[event] ?? [])]) {
      try {
        fn(...args);
      } catch (e) {
        console.error(`pairwise: ${String(event)} listener failed`, e);
      }
    }
  }
}
