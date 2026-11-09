import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getStatus() {
    return {
      status: 'ok',
      service: 'api',
      instance: process.env.INSTANCE_ID ?? 'unknown',
    };
  }
}
