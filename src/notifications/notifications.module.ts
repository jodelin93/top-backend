import { Global, Logger, Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsService } from './notifications.service';
import { NotificationGeneratorsService } from './notification-generators.service';
import { NotificationsController } from './notifications.controller';
import { DisabledEmailChannel, EMAIL_CHANNEL } from './email/email-channel';
import {
  SmtpEmailChannel,
  smtpConfigFromEnv,
} from './email/smtp-email.channel';

// Global: any module (jobs, reconciliation) may raise notifications
@Global()
@Module({
  imports: [SettingsModule],
  controllers: [NotificationsController],
  providers: [
    {
      provide: EMAIL_CHANNEL,
      // SMTP when SMTP_HOST is set, otherwise e-mail is off
      useFactory: () => {
        const config = smtpConfigFromEnv();
        if (!config) return new DisabledEmailChannel();
        new Logger('Notifications').log(
          `E-mail notifications via ${config.host}:${config.port}`,
        );
        return new SmtpEmailChannel(config);
      },
    },
    NotificationsService,
    NotificationGeneratorsService,
  ],
  // EMAIL_CHANNEL: other modules send their own e-mail (e.g. receipts, src/documents)
  exports: [NotificationsService, NotificationGeneratorsService, EMAIL_CHANNEL],
})
export class NotificationsModule {}
