/* Orbit — image helpers for the offscreen document (thumbnails, decoding). */
import { bytesToDataUrl } from './crypto.js';

const { LIMITS } = globalThis.ORBIT;

/** Decode image bytes, return {w, h}. */
export async function imageSize(bytes, mime) {
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
    const r = { w: bmp.width, h: bmp.height };
    bmp.close();
    return r;
  } catch (e) { return { w: 0, h: 0 }; }
}

/** Small WebP thumbnail (first frame for GIFs) as data URL, targeting <= MAX_THUMB_BYTES. */
export async function makeThumb(bytes, mime, maxEdge = 200) {
  let bmp;
  try { bmp = await createImageBitmap(new Blob([bytes], { type: mime })); } catch (e) { return ''; }
  try {
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d');
    g.drawImage(bmp, 0, 0, w, h);
    let q = 0.6;
    for (let i = 0; i < 4; i++) {
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: q });
      if (blob.size <= LIMITS.MAX_THUMB_BYTES || i === 3) {
        return bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), 'image/webp');
      }
      q -= 0.15;
    }
    return '';
  } finally { bmp.close(); }
}

/** Sniff the real type from magic bytes; reject mismatches (never trust the declared MIME). */
export function sniffImageMime(bytes) {
  if (bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
