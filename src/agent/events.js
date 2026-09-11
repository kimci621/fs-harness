// Поток событий рана: async iterable + широковещательный on().
//
// Голый EventEmitter тут не годится: фазы стартуют мгновенно, а TUI подписывается уже после
// старта — события, испущенные до подписки, потерялись бы. Поэтому буфер и свой курсор у каждого
// итератора: подписался позже — всё равно прочитал с начала.
//
// ponytail: буфер не подрезается, память растёт с числом событий рана. Для одного запуска агента
// потолок приемлемый; если упрёмся — сбрасывать хвост в events.jsonl и держать в памяти окно.
export function createEventStream() {
  const buffer = [];
  const listeners = new Set();
  const waiters = new Set();
  let closed = false;

  const wake = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };

  return {
    push(ev) {
      if (closed) return;
      buffer.push(ev);
      for (const fn of listeners) fn(ev);
      wake();
    },

    close() {
      if (closed) return;
      closed = true;
      wake();
    },

    get closed() {
      return closed;
    },

    // Подписка без backpressure (MCP-notify): отдаёт только то, что придёт дальше.
    // Возвращает функцию отписки.
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async *[Symbol.asyncIterator]() {
      let i = 0;
      while (true) {
        while (i < buffer.length) yield buffer[i++];
        if (closed) return;
        await new Promise((resolve) => waiters.add(resolve));
      }
    },
  };
}
