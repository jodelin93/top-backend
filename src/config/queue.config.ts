import { registerAs } from '@nestjs/config';
import { QueueOptions } from 'bullmq';

export default registerAs(
  'queue',
  (): QueueOptions => ({
    connection: {
      host: process.env.QUEUE_REDIS_HOST || 'localhost',
      port: parseInt(process.env.QUEUE_REDIS_PORT || '6379', 10),
      password: process.env.QUEUE_REDIS_PASSWORD || undefined,
      db: parseInt(process.env.QUEUE_REDIS_DB || '1', 10),
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: {
        age: 3600, // Keep completed jobs for 1 hour
        count: 1000,
      },
      removeOnFail: {
        age: 86400, // Keep failed jobs for 24 hours
      },
    },
  }),
);
