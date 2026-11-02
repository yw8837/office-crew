// SSE 이벤트 허브: 브라우저 여러 개가 같은 이벤트를 받는다
export class Bus {
  constructor() {
    this.clients = new Set();
    this.listeners = new Set();
    this.heartbeat = setInterval(() => this.#write(':hb\n\n'), 20000);
    this.heartbeat.unref?.();
  }

  attach(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  // 서버 내부 구독(테스트·로그용)
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, data) {
    for (const fn of this.listeners) {
      try { fn(type, data); } catch { /* 구독자 오류는 무시 */ }
    }
    this.#write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  #write(chunk) {
    for (const res of this.clients) {
      try { res.write(chunk); } catch { this.clients.delete(res); }
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const res of this.clients) { try { res.end(); } catch { /* 이미 닫힘 */ } }
    this.clients.clear();
  }
}
