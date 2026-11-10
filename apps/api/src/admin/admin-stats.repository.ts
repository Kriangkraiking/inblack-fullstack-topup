import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { StatsRow } from './admin-stats.js';

/** Whole-system numbers for the admin dashboard, read from Postgres (same on every replica). */
@Injectable()
export class AdminStatsRepository {
  constructor(private readonly db: DbService) {}

  async read(): Promise<{ row: StatsRow; byStatus: { status: string; n: string }[] }> {
    const [stats, byStatus] = await Promise.all([
      this.db.query<StatsRow>('SELECT * FROM admin_dashboard_stats()'),
      this.db.query<{ status: string; n: string }>(
        'SELECT status, count(*) AS n FROM orders GROUP BY status',
      ),
    ]);
    return { row: stats.rows[0], byStatus: byStatus.rows };
  }
}
