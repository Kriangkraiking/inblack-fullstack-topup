import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { parseWith } from '../common/validate.js';
import { AdminAuthRepository } from './admin-auth.repository.js';
import { RequireRole } from './admin-roles.js';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .regex(/^[1-9]\d{0,17}$/)
    .optional(),
  action: z
    .string()
    .regex(/^[a-z_.]{1,64}$/)
    .optional(),
});

@Controller('api/v1/admin/audit-logs')
export class AuditLogsController {
  constructor(private readonly repository: AdminAuthRepository) {}

  @Get()
  @RequireRole('finance')
  async list(@Query() query: unknown) {
    const input = parseWith(querySchema, query);
    const rows = await this.repository.listAudit(
      input.limit,
      input.cursor ?? null,
      input.action ?? null,
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        admin_email: row.admin_email,
        action: row.action,
        target: row.target,
        detail: row.detail,
        created_at: row.created_at.toISOString(),
      })),
      // Ordered by id, so a new row cannot make a page repeat or skip.
      next_cursor: rows.length === input.limit ? rows[rows.length - 1].id : null,
    };
  }
}
