/** Node has no FixedLengthStream (a workerd global). Tests that run R2ExportCache in Node install this stand-in with
 *  the documented semantics: bytes pass through, and writing more or fewer than `length` bytes errors the stream.
 *  The workerd tests use the real one. Not imported by the Worker. */
export function installFixedLengthStream(): void {
  const g = globalThis as { FixedLengthStream?: unknown };
  if (typeof g.FixedLengthStream === "function") return;
  g.FixedLengthStream = class extends TransformStream<Uint8Array, Uint8Array> {
    constructor(length: number | bigint) {
      const expected = Number(length);
      let seen = 0;
      super({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > expected) throw new Error("Attempt to write too many bytes through a FixedLengthStream.");
          controller.enqueue(chunk);
        },
        flush() {
          if (seen !== expected) throw new Error("FixedLengthStream did not see all expected bytes before close().");
        },
      });
    }
  };
}
