// stdin 스트림 JSON으로 여러 턴을 넣는 CLI(Claude)용: 보낸 메시지가 모두 소비되고 턴이 끝나면 stdin을 닫는다
export class TurnFeeder {
  constructor(child, encode) {
    this.child = child;
    this.encode = encode;
    this.sent = 0;
    this.acked = 0;
    this.results = 0;
    this.closed = false;
    this.timer = null;
  }

  send(text, images = []) {
    if (this.closed || !this.child.stdin.writable) return false;
    this.child.stdin.write(`${JSON.stringify(this.encode(text, images))}\n`);
    this.sent++;
    clearTimeout(this.timer);
    return true;
  }

  ack() { this.acked = Math.min(this.sent, this.acked + 1); }

  result() {
    this.results++;
    if (this.acked >= this.sent) return this.close();
    // 안 소비된 메시지가 있으면 다음 턴을 기다리되, 조용하면 닫는다
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(), 20000);
    this.timer.unref?.();
  }

  close() {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin.end(); } catch { /* 이미 닫힘 */ }
  }
}
