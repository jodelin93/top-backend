/**
 * Image upload checks. The type is taken from the file's magic bytes, never from
 * the client-supplied mimetype or file name.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface DetectedImage {
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (buffer: Buffer, bytes: number[], offset = 0) =>
  buffer.length >= offset + bytes.length &&
  bytes.every((byte, i) => buffer[offset + i] === byte);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** JPEG, PNG or WebP by signature; null for anything else. */
export function detectImageType(buffer: Buffer): DetectedImage | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return { contentType: 'image/png', extension: 'png' };
  }
  // RIFF....WEBP
  if (
    startsWith(buffer, ascii('RIFF')) &&
    startsWith(buffer, ascii('WEBP'), 8)
  ) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  return null;
}

export const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
