import { Controller, Get, Header } from '@nestjs/common';
import { RequireRole } from './admin-roles.js';
import { AdminStatsRepository } from './admin-stats.repository.js';
import { renderStats, type AdminStats } from './admin-stats.js';

const CACHE_MS = 5000;

/**
 * Dashboard numbers. Cached for 5 seconds per replica, which bounds the load of a dashboard that
 * polls; the two replicas may differ by up to that much. No query parameters.
 */
@Controller('api/v1/admin/stats')
export class AdminStatsController {
  private cached?: { at: number; stats: AdminStats };

  constructor(private readonly repository: AdminStatsRepository) {}

  @Get()
  @RequireRole('viewer')
  @Header('Cache-Control', 'private, no-store')
  async get(): Promise<AdminStats> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.stats;
    const { row, byStatus } = await this.repository.read();
    const stats = renderStats(row, byStatus, new Date());
    this.cached = { at: Date.now(), stats };
    return stats;
  }
}
