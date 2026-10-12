// A small MessagePack reader for Visual Studio's Copilot chat files: a stream of values read one
// at a time, so a caller can stop after the values it needs. Binary and extension values are
// skipped (returned as null), except timestamps.

export class MsgpackReader {
  private pos: number;

  constructor(
    private readonly buf: Buffer,
    start = 0,
  ) {
    this.pos = start;
  }

  /** True when every byte has been read. */
  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** The next value; throws on truncated or unknown input. */
  next(): unknown {
    const b = this.u8();
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if ((b & 0xf0) === 0x80) return this.map(b & 0x0f);
    if ((b & 0xf0) === 0x90) return this.array(b & 0x0f);
    if ((b & 0xe0) === 0xa0) return this.str(b & 0x1f);
    switch (b) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return this.skip(this.u8());
      case 0xc5:
        return this.skip(this.u16());
      case 0xc6:
        return this.skip(this.u32());
      case 0xc7:
        return this.ext(this.u8());
      case 0xc8:
        return this.ext(this.u16());
      case 0xc9:
        return this.ext(this.u32());
      case 0xca:
        return this.num(4, (o) => this.buf.readFloatBE(o));
      case 0xcb:
        return this.num(8, (o) => this.buf.readDoubleBE(o));
      case 0xcc:
        return this.u8();
      case 0xcd:
        return this.u16();
      case 0xce:
        return this.u32();
      case 0xcf:
        return this.num(8, (o) => Number(this.buf.readBigUInt64BE(o)));
      case 0xd0:
        return this.num(1, (o) => this.buf.readInt8(o));
      case 0xd1:
        return this.num(2, (o) => this.buf.readInt16BE(o));
      case 0xd2:
        return this.num(4, (o) => this.buf.readInt32BE(o));
      case 0xd3:
        return this.num(8, (o) => Number(this.buf.readBigInt64BE(o)));
      case 0xd4:
        return this.ext(1);
      case 0xd5:
        return this.ext(2);
      case 0xd6:
        return this.ext(4);
      case 0xd7:
        return this.ext(8);
      case 0xd8:
        return this.ext(16);
      case 0xd9:
        return this.str(this.u8());
      case 0xda:
        return this.str(this.u16());
      case 0xdb:
        return this.str(this.u32());
      case 0xdc:
        return this.array(this.u16());
      case 0xdd:
        return this.array(this.u32());
      case 0xde:
        return this.map(this.u16());
      case 0xdf:
        return this.map(this.u32());
    }
    throw new Error(`unknown MessagePack type 0x${b.toString(16)} at byte ${this.pos - 1}`);
  }

  private take(n: number): number {
    if (this.pos + n > this.buf.length) throw new Error("truncated MessagePack data");
    const at = this.pos;
    this.pos += n;
    return at;
  }
  private num(n: number, read: (offset: number) => number): number {
    return read(this.take(n));
  }
  private u8 = (): number => this.num(1, (o) => this.buf.readUInt8(o));
  private u16 = (): number => this.num(2, (o) => this.buf.readUInt16BE(o));
  private u32 = (): number => this.num(4, (o) => this.buf.readUInt32BE(o));
  private skip(n: number): null {
    this.take(n);
    return null;
  }
  private str(n: number): string {
    const at = this.take(n);
    return this.buf.toString("utf8", at, at + n);
  }
  private array(n: number): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(this.next());
    return out;
  }
  private map(n: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) {
      const key = this.next();
      out[String(key)] = this.next();
    }
    return out;
  }
  /** Extension value: timestamps (type -1) become a Date, anything else is skipped. */
  private ext(n: number): Date | null {
    const type = this.num(1, (o) => this.buf.readInt8(o));
    const at = this.take(n);
    if (type !== -1) return null;
    if (n === 4) return new Date(this.buf.readUInt32BE(at) * 1000);
    if (n === 8) {
      const hi = this.buf.readUInt32BE(at);
      const lo = this.buf.readUInt32BE(at + 4);
      return new Date(((hi & 0x3) * 2 ** 32 + lo) * 1000 + Math.floor(hi / 4) / 1e6);
    }
    return new Date(Number(this.buf.readBigInt64BE(at + 4)) * 1000);
  }
}
