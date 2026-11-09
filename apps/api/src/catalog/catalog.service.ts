import { Injectable } from '@nestjs/common';
import { toSatang } from '@inblack/domain';
import { ProblemError } from '../common/problem.js';
import { CatalogRepository, type ProductRow } from './catalog.repository.js';

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

@Injectable()
export class CatalogService {
  constructor(private readonly products: CatalogRepository) {}

  async list() {
    return { items: (await this.products.findActive()).map(renderProduct) };
  }

  async getBySlug(slug: string) {
    const product = await this.products.findActiveBySlug(slug);
    if (!product) throw new ProblemError(404, 'PRODUCT_NOT_FOUND', 'no product has this slug');
    return renderProduct(product);
  }
}
