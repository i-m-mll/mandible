export declare class RingBuffer {
    private buf;
    private head;
    private size;
    constructor(capacity?: number);
    append(data: string): void;
    snapshot(): Buffer;
    clear(): void;
    get byteLength(): number;
}
