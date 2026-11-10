import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';

export interface ProductRow {
  sku: string;
  slug: string;
  name: string;
  price_satang: string;
  stock: number | null;
  max_qty_per_order: number | null;
  max_qty_per_email: number | null;
  category: string | null;
  description: string | null;
  image_path: string | null;
}

@Injectable()
export class CatalogRepository {
  constructor(private readonly db: DbService) {}

  async findActive(): Promise<ProductRow[]> {
    const { rows } = await this.db.query<ProductRow>(
      `SELECT sku, slug, name, price_satang, stock, max_qty_per_order, max_qty_per_email,
              category, description, image_path
       FROM products WHERE active ORDER BY sku`,
    );
    return rows;
  }

  async findActiveBySlug(slug: string): Promise<ProductRow | undefined> {
    const { rows } = await this.db.query<ProductRow>(
      `SELECT sku, slug, name, price_satang, stock, max_qty_per_order, max_qty_per_email,
              category, description, image_path
       FROM products WHERE slug = $1 AND active`,
      [slug],
    );
    return rows[0];
  }
}
