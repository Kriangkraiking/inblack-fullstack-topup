import {
  Controller,
  HttpCode,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminAuthRepository } from '../admin/admin-auth.repository.js';
import { CurrentAdmin, RequireRole, type Admin } from '../admin/admin-roles.js';
import { ProblemError } from '../common/problem.js';
import { parseWith } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import { compareSettlement, type MismatchType } from './compare-settlement.js';
import { ReconciliationRepository } from './reconciliation.repository.js';
import { parseSettlementCsv } from './settlement-csv.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const querySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/**
 * Reads to the end even when over the limit, keeping nothing past it. Answering early closes the
 * connection under nginx mid-upload, and nginx then reports a broken upstream instead of this 413.
 * nginx caps the total in front of this.
 */
function readTextBody(request: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_FILE_BYTES) chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > MAX_FILE_BYTES) {
        reject(new ProblemError(413, 'CSV_TOO_LARGE', `at most ${MAX_FILE_BYTES} bytes`));
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    request.on('error', reject);
  });
}

@Controller('api/v1/admin/reconciliation')
export class ReconciliationController {
  constructor(
    private readonly repository: ReconciliationRepository,
    private readonly audit: AdminAuthRepository,
    private readonly db: DbService,
  ) {}

  /**
   * Takes the file as text/csv or as the `file` field of a multipart form. Keeps nothing except
   * the audit row, because the answer can be recomputed from the same file.
   */
  @Post()
  @HttpCode(200)
  @RequireRole('finance')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES, files: 1 } }))
  async run(
    @Req() request: Request,
    @Query() query: unknown,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @CurrentAdmin() admin: Admin,
  ) {
    const window = parseWith(querySchema, query);
    const rows = parseSettlementCsv(await this.csvText(request, file));

    const mismatches = compareSettlement(rows, await this.repository.loadSnapshot(), {
      from: window.from ? new Date(window.from) : undefined,
      to: window.to ? new Date(window.to) : undefined,
    });

    const counts: Record<MismatchType, number> = {
      MISSING_IN_SYSTEM: 0,
      MISSING_AT_PROVIDER: 0,
      AMOUNT_MISMATCH: 0,
      STATUS_MISMATCH: 0,
    };
    for (const mismatch of mismatches) counts[mismatch.type] += 1;

    await this.db.transaction((tx) =>
      this.audit.insertAudit(tx, admin.id, 'reconciliation.run', null, { rows: rows.length, ...counts }),
    );
    return { rows: rows.length, counts, mismatches };
  }

  private async csvText(request: Request, file: { buffer: Buffer } | undefined): Promise<string> {
    if (file) return file.buffer.toString('utf8');
    const contentType = request.headers['content-type'] ?? '';
    if (contentType.startsWith('multipart/form-data')) {
      throw new ProblemError(422, 'CSV_REQUIRED', 'send the file in a field named file');
    }
    if (!contentType.startsWith('text/csv')) {
      throw new ProblemError(415, 'UNSUPPORTED_MEDIA_TYPE', 'send text/csv or multipart/form-data');
    }
    return readTextBody(request);
  }
}
