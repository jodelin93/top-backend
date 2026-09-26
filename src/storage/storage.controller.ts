import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { existsSync } from 'fs';
import { CONTENT_TYPE_BY_EXTENSION } from './image-validation';
import { isValidStorageKey, StorageService } from './storage.service';
import { Public } from '../auth/decorators/public.decorator';

/**
 * Public file delivery for <img> tags (no auth header is possible there).
 * Keys are random 128-bit names, so URLs are unguessable.
 */
@ApiExcludeController()
@Public()
@Controller('storage')
export class StorageController {
  constructor(private storage: StorageService) {}

  @Get('files/*key')
  async file(
    @Param('key') rawKey: string | string[],
    @Res() res: Response,
  ): Promise<void> {
    const key = Array.isArray(rawKey) ? rawKey.join('/') : rawKey;
    if (!isValidStorageKey(key)) {
      throw new NotFoundException('File not found');
    }
    // The admin and POS run on another origin
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (this.storage.driver === 's3') {
      const url = await this.storage.presignedUrl(key);
      // Cache the redirect for less time than the signature lives
      res.setHeader(
        'Cache-Control',
        `private, max-age=${Math.min(300, this.storage.presignSeconds)}`,
      );
      res.redirect(302, url);
      return;
    }

    const path = this.storage.localPath(key);
    if (!existsSync(path)) {
      throw new NotFoundException('File not found');
    }
    const extension = key.slice(key.lastIndexOf('.') + 1);
    res.setHeader('Content-Type', CONTENT_TYPE_BY_EXTENSION[extension]);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.sendFile(path, { dotfiles: 'deny' });
  }
}
