import type { NestApplicationOptions } from '@nestjs/common';

export const APP_OPTIONS: NestApplicationOptions = {
  // Keeps the original bytes on req.rawBody. Webhook signatures are checked against those.
  rawBody: true,
};
