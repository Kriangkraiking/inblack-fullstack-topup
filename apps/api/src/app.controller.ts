import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getStatus() {
    return this.appService.getStatus();
  }

  // Liveness only: must never touch Postgres, Redis or any other dependency.
  @Get('healthz')
  getHealth() {
    return { status: 'ok' };
  }
}
