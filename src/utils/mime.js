'use strict';

/**
 * Content sniffing by magic bytes. The declared Content-Type of uploads is
 * never trusted on its own; the actual file signature must match an allowed
 * format.
 */

const SIGNATURES = [
  { mime: 'image/jpeg', kind: 'image', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', kind: 'image', ext: 'png', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/gif', kind: 'image', ext: 'gif', test: (b) => b.slice(0, 4).toString('ascii') === 'GIF8' },
  { mime: 'image/webp', kind: 'image', ext: 'webp', test: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
  { mime: 'video/webm', kind: 'video', ext: 'webm', test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  {
    mime: 'video/mp4',
    kind: 'video',
    ext: 'mp4',
    test: (b) => {
      if (b.slice(4, 8).toString('ascii') !== 'ftyp') return false;
      const brand = b.slice(8, 12).toString('ascii');
      return brand !== 'qt  ' && !/^(heic|heix|mif1|avif)/.test(brand);
    }
  },
  { mime: 'video/quicktime', kind: 'video', ext: 'mov', test: (b) => b.slice(4, 8).toString('ascii') === 'ftyp' && b.slice(8, 12).toString('ascii') === 'qt  ' }
];

/**
 * @param {Buffer} buffer
 * @returns {{ mime: string, kind: 'image'|'video', ext: string } | null}
 */
function detectMediaType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const match = SIGNATURES.find((sig) => sig.test(buffer));
  return match ? { mime: match.mime, kind: match.kind, ext: match.ext } : null;
}

const EXTENSION_BY_MIME = SIGNATURES.reduce((acc, s) => ({ ...acc, [s.mime]: s.ext }), {});

module.exports = { detectMediaType, EXTENSION_BY_MIME };
