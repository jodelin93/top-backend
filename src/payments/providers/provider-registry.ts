import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isStrictEnv } from '../../config/environment';
import { PaymentProvider } from './payment-provider';
import { ManualPaymentProvider } from './manual.provider';
import { MockPaymentProvider } from './mock.provider';

/**
 * Registered payment provider adapters, by name.
 *
 * - `manual` is always available.
 * - `mock` is available in development/test only (or with PAYMENT_MOCK_ENABLED=true);
 *   never by default in production, staging or any other strict environment.
 * Webhook secrets come from PAYMENT_WEBHOOK_SECRET_<NAME> (e.g. PAYMENT_WEBHOOK_SECRET_MOCK).
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly logger = new Logger(PaymentProviderRegistry.name);
  private readonly providers = new Map<string, PaymentProvider>();
  private readonly secrets = new Map<string, string>();

  constructor(private configService: ConfigService) {
    this.register(new ManualPaymentProvider());

    const strict = isStrictEnv(configService.get<string>('NODE_ENV'));
    const mockEnabled =
      configService.get<string>('PAYMENT_MOCK_ENABLED') ??
      (strict ? 'false' : 'true');
    if (mockEnabled === 'true') {
      // Without a configured secret the mock signs its own webhooks with a random one
      const secret =
        this.envSecret('mock') ?? MockPaymentProvider.randomSecret();
      this.secrets.set('mock', secret);
      this.register(
        new MockPaymentProvider({
          delayMs: Number(
            configService.get<string>('PAYMENT_MOCK_DELAY_MS') ?? 3000,
          ),
          secret,
          sendWebhooks:
            configService.get<string>('PAYMENT_MOCK_WEBHOOKS') !== 'false',
        }),
      );
    }
  }

  register(provider: PaymentProvider) {
    this.providers.set(provider.name, provider);
    this.logger.debug(`Payment provider registered: ${provider.name}`);
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  get(name: string): PaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new BadRequestException(`Unknown payment provider "${name}"`);
    }
    return provider;
  }

  list(): { name: string; label: string; async: boolean }[] {
    return [...this.providers.values()].map((p) => ({
      name: p.name,
      label: p.label,
      async: p.async,
    }));
  }

  webhookSecret(name: string): string | null {
    return this.secrets.get(name) ?? this.envSecret(name);
  }

  private envSecret(name: string): string | null {
    return (
      this.configService.get<string>(
        `PAYMENT_WEBHOOK_SECRET_${name.toUpperCase()}`,
      ) || null
    );
  }
}
