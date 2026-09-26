import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { errorMessage, LOCKS, scheduleDaily } from '../platform/scheduling';
import { StoredValueService } from './stored-value.service';

/**
 * Daily gift card expiry (store setting giftCardExpiryMonths, 0 = never): the
 * remaining value of gift cards past their expiresAt is written off with an
 * 'expire' entry (audited, stored_value.changed event). Cards get expiresAt when
 * sold; spending an expired card is refused anyway, so the job only has to keep
 * the liability right. One instance at a time (advisory lock); GIFT_CARD_EXPIRY=off
 * disables it.
 */
@Injectable()
export class GiftCardExpiryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(GiftCardExpiryService.name);
  private stop: (() => void) | null = null;

  constructor(
    private dataSource: DataSource,
    private storedValue: StoredValueService,
  ) {}

  onApplicationBootstrap() {
    this.stop = scheduleDaily(this.dataSource, {
      lockKey: LOCKS.giftCardExpiry,
      envSwitch: 'GIFT_CARD_EXPIRY',
      job: () => this.run(),
      onError: (error) =>
        this.logger.error(`Gift card expiry failed: ${errorMessage(error)}`),
    });
  }

  onModuleDestroy() {
    this.stop?.();
    this.stop = null;
  }

  /** Expire every due card, in batches. Returns the number of cards expired. */
  async run(now = new Date()): Promise<number> {
    let total = 0;
    for (;;) {
      const expired = await this.storedValue.expireDue(now);
      total += expired;
      if (expired === 0) break;
    }
    if (total > 0) this.logger.log(`Expired ${total} gift card(s)`);
    return total;
  }
}
