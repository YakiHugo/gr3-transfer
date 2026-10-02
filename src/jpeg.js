import { AppError } from './camera.js';

/** Incremental marker-level JPEG validation. Never decodes, transforms or rewrites bytes.
 * Skips marker payloads, including embedded EXIF JPEGs, so their EOI is not mistaken
 * for the outer image's completion. This is structural validation, not pixel decoding.
 */
export class JpegValidator {
  constructor() {
    this.state = 'soi1'; this.marker = 0; this.remaining = 0;
    this.segmentLength = 0; this.header = []; this.frame = false; this.scan = false; this.entropy = false;
    this.components = new Set();
  }
  fail() { throw new AppError('The JPEG transfer was incomplete or malformed. Retry this file.', 'INCOMPLETE_JPEG'); }
  markerCode(code) {
    if (code === 0xff) { this.state = 'marker'; return; }
    if (code === 0xd9) {
      if (!this.frame || !this.scan || !this.entropy) this.fail();
      this.state = 'done'; return;
    }
    if (code === 0 || code === 0xd8 || (code >= 0xd0 && code <= 0xd7)) this.fail();
    if (code === 0x01) { this.state = 'prefix'; return; }
    this.marker = code; this.header = []; this.state = 'length1';
  }
  endSegment() {
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(this.marker)) {
      const count = this.header[5];
      if (!count || count > 4 || this.segmentLength !== 8 + 3 * count || !((this.header[1] << 8) | this.header[2]) || !((this.header[3] << 8) | this.header[4])) this.fail();
      this.components = new Set(Array.from({ length: count }, (_, i) => this.header[6 + 3 * i]));
      if (this.components.size !== count) this.fail();
      this.frame = true;
    }
    if (this.marker === 0xda) {
      const count = this.header[0];
      if (!this.frame || !count || count > 4 || this.segmentLength !== 6 + 2 * count) this.fail();
      const scanComponents = new Set(Array.from({ length: count }, (_, i) => this.header[1 + 2 * i]));
      if (scanComponents.size !== count || [...scanComponents].some(id => !this.components.has(id))) this.fail();
      this.scan = true; this.state = 'scan';
    } else this.state = 'prefix';
  }
  push(bytes) {
    for (const byte of bytes) {
      switch (this.state) {
        case 'soi1': if (byte !== 0xff) this.fail(); this.state = 'soi2'; break;
        case 'soi2': if (byte !== 0xd8) this.fail(); this.state = 'prefix'; break;
        case 'prefix': if (byte !== 0xff) this.fail(); this.state = 'marker'; break;
        case 'marker': this.markerCode(byte); break;
        case 'length1': this.segmentLength = byte << 8; this.state = 'length2'; break;
        case 'length2':
          this.segmentLength |= byte; this.remaining = this.segmentLength - 2;
          if (this.remaining < 0) this.fail();
          this.state = 'segment'; if (this.remaining === 0) this.endSegment(); break;
        case 'segment':
          if (this.header.length < 20) this.header.push(byte);
          if (--this.remaining === 0) this.endSegment(); break;
        case 'scan':
          if (byte === 0xff) this.state = 'scanMarker'; else this.entropy = true;
          break;
        case 'scanMarker':
          if (byte === 0 || (byte >= 0xd0 && byte <= 0xd7)) { this.entropy = true; this.state = 'scan'; }
          else if (byte !== 0xff) this.markerCode(byte);
          break;
        case 'done': break; // Preserve any vendor trailer; upstream length is checked separately.
        default: this.fail();
      }
    }
  }
  finish() { if (this.state !== 'done') this.fail(); }
}
