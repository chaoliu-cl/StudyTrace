// Minimal ZIP writer for study exports (deflate, UTF-8 names, no ZIP64).
//
// Entries are compressed one at a time and written to the output stream as
// they are added, so only one file's contents is held in memory at once.
// Limits: fewer than 65,535 entries and under 4 GB in total.

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export class ZipWriter {
  constructor(stream) {
    this.stream = stream;
    this.offset = 0;
    this.entries = [];
  }

  async write(buffer) {
    this.offset += buffer.length;
    if (!this.stream.write(buffer)) {
      await new Promise((resolve) => this.stream.once('drain', resolve));
    }
  }

  async addFile(name, contents) {
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const { time, day } = dosDateTime(new Date());
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 file names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    header.writeUInt16LE(0, 28);
    this.entries.push({ nameBuffer, crc, compressedSize: compressed.length, size: data.length, offset: this.offset, time, day });
    await this.write(header);
    await this.write(nameBuffer);
    await this.write(compressed);
  }

  async finish() {
    const start = this.offset;
    for (const entry of this.entries) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4); // version made by
      record.writeUInt16LE(20, 6); // version needed
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(8, 10);
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.day, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressedSize, 20);
      record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(entry.nameBuffer.length, 28);
      record.writeUInt32LE(entry.offset, 42);
      await this.write(record);
      await this.write(entry.nameBuffer);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    this.stream.end();
  }
}
