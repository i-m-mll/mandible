const DEFAULT_RING_BUFFER_BYTES = 512 * 1024;

export class RingBuffer {
  private buf: Buffer;
  private head = 0;
  private size = 0;

  constructor(capacity: number = DEFAULT_RING_BUFFER_BYTES) {
    this.buf = Buffer.allocUnsafe(capacity);
  }

  append(data: string): void {
    const incoming = Buffer.from(data, "utf8");
    const cap = this.buf.length;
    let offset = 0;
    let remaining = incoming.length;

    while (remaining > 0) {
      const canWrite = Math.min(remaining, cap - this.head);
      incoming.copy(this.buf, this.head, offset, offset + canWrite);
      this.head = (this.head + canWrite) % cap;
      this.size = Math.min(this.size + canWrite, cap);
      offset += canWrite;
      remaining -= canWrite;
    }
  }

  snapshot(): Buffer {
    if (this.size === 0) return Buffer.alloc(0);
    const cap = this.buf.length;

    if (this.size < cap) {
      const start = (this.head - this.size + cap) % cap;
      return Buffer.from(this.buf.subarray(start, start + this.size));
    }

    const result = Buffer.allocUnsafe(cap);
    const tail = this.buf.subarray(this.head);
    const front = this.buf.subarray(0, this.head);
    tail.copy(result, 0);
    front.copy(result, tail.length);
    return result;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  get byteLength(): number {
    return this.size;
  }
}
