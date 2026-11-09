import { Controller, Get, Header, Param } from '@nestjs/common';
import { toSatang } from '@inblack/domain';
import { ProblemError } from '../common/problem.js';
import { DbService } from '../db/db.service.js';

// Short, because the flash sale stock in this response goes stale.
const CACHE_CONTROL = 'public, max-age=15';

interface ProductRow {
  sku: string;
  slug: string;
  name: string;
  price_satang: string;
  stock: number | null;
  max_qty_per_order: number | null;
  max_qty_per_email: number | null;
}

const PRODUCT_COLUMNS =
  'sku, slug, name, price_satang, stock, max_qty_per_order, max_qty_per_email';

function renderProduct(row: ProductRow) {
  return {
    sku: row.sku,
    slug: row.slug,
    name: row.name,
    price_satang: toSatang(row.price_satang),
    // null means unlimited.
    stock: row.stock,
    max_qty_per_order: row.max_qty_per_order,
    max_qty_per_email: row.max_qty_per_email,
  };
}

@Controller('api/v1/products')
export class CatalogController {
  constructor(private readonly db: DbService) {}

  @Get()
  @Header('Cache-Control', CACHE_CONTROL)
  async list() {
    const { rows } = await this.db.query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE active ORDER BY sku`,
    );
    return { items: rows.map(renderProduct) };
  }

  @Get(':slug')
  @Header('Cache-Control', CACHE_CONTROL)
  async get(@Param('slug') slug: string) {
    const { rows } = await this.db.query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE slug = $1 AND active`,
      [slug],
    );
    if (rows.length === 0) {
      throw new ProblemError(404, 'PRODUCT_NOT_FOUND', 'no product has this slug');
    }
    return renderProduct(rows[0]);
  }
}
