import { detectImageType } from './image-validation';
import { isValidStorageKey } from './storage.service';

const bytes = (...values: number[]) => Buffer.from(values);

describe('detectImageType', () => {
  it('recognises JPEG, PNG and WebP by their signatures', () => {
    expect(
      detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0))?.extension,
    ).toBe('jpg');
    expect(
      detectImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))
        ?.contentType,
    ).toBe('image/png');
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      bytes(0x24, 0, 0, 0),
      Buffer.from('WEBPVP8 '),
    ]);
    expect(detectImageType(webp)?.extension).toBe('webp');
  });

  it('rejects other content even when it claims to be an image', () => {
    expect(detectImageType(Buffer.from('<svg xmlns="..."></svg>'))).toBeNull();
    expect(detectImageType(Buffer.from('GIF89a......'))).toBeNull();
    expect(detectImageType(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
    expect(detectImageType(bytes(0xff, 0xd8))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('isValidStorageKey', () => {
  it('accepts generated keys', () => {
    expect(
      isValidStorageKey(
        'products/0b9a4c1e-1111-2222-3333-444455556666/abc/0123456789abcdef.webp',
      ),
    ).toBe(true);
  });

  it('rejects traversal and unexpected names', () => {
    expect(isValidStorageKey('../etc/passwd')).toBe(false);
    expect(isValidStorageKey('products/../../secret.png')).toBe(false);
    expect(isValidStorageKey('/abs/path.png')).toBe(false);
    expect(isValidStorageKey('products/x.svg')).toBe(false);
    expect(isValidStorageKey('products/X.png')).toBe(false);
    expect(isValidStorageKey('products//x.png')).toBe(false);
    expect(isValidStorageKey('products/x.png%00.txt')).toBe(false);
  });
});
