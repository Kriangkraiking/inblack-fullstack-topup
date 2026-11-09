import { Controller, Get, Header, Param } from '@nestjs/common';
import { z } from 'zod';
import { parseWith } from '../common/validate.js';
import { CatalogService } from './catalog.service.js';

// Short, because the flash sale stock in this response goes stale.
const CACHE_CONTROL = 'public, max-age=15';

const slugSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

@Controller('api/v1/products')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @Header('Cache-Control', CACHE_CONTROL)
  list() {
    return this.catalog.list();
  }

  @Get(':slug')
  @Header('Cache-Control', CACHE_CONTROL)
  get(@Param('slug') slug: string) {
    return this.catalog.getBySlug(parseWith(slugSchema, slug));
  }
}
