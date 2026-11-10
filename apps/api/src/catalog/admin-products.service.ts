import { Injectable } from '@nestjs/common';
import { toSatang } from '@inblack/domain';
import { AdminAuthRepository } from '../admin/admin-auth.repository.js';
import type { Admin } from '../admin/admin-roles.js';
import { ProblemError } from '../common/problem.js';
import { AdminProductsRepository, type AdminProductRow } from './admin-products.repository.js';
import { decideStock, type ProductPatch } from './product-edit.js';

export function renderAdminProduct(row: AdminProductRow) {
  return {
    sku: row.sku,
    slug: row.slug,
    name: row.name,
    price_satang: toSatang(row.price_satang),
    stock: row.stock,
    max_qty_per_order: row.max_qty_per_order,
    max_qty_per_email: row.max_qty_per_email,
    active: row.active,
    updated_at: row.updated_at.toISOString(),
  };
}

const productNotFound = () => new ProblemError(404, 'PRODUCT_NOT_FOUND', 'no product has this sku');

@Injectable()
export class AdminProductsService {
  constructor(
    private readonly products: AdminProductsRepository,
    private readonly audit: AdminAuthRepository,
  ) {}

  async list() {
    return { items: (await this.products.list()).map(renderAdminProduct) };
  }

  /** Lock, decide, write, audit: one transaction, so the audit row exists exactly when the edit does. */
  async update(admin: Admin, sku: string, patch: ProductPatch) {
    return this.products.transaction(async (tx) => {
      const before = await this.products.lock(tx, sku);
      if (!before) throw productNotFound();
      const stock = decideStock(before.stock, patch);
      const after = await this.products.update(
        tx,
        sku,
        { name: patch.name, priceSatang: patch.price_satang, stock },
        before.stock,
      );
      if (!after) throw new ProblemError(409, 'STOCK_CHANGED', 'stock changed while saving, reload and try again');
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (patch.name !== undefined && patch.name !== before.name) changes.name = { from: before.name, to: after.name };
      if (patch.price_satang !== undefined && toSatang(before.price_satang) !== patch.price_satang) {
        changes.price_satang = { from: toSatang(before.price_satang), to: patch.price_satang };
      }
      if (stock !== undefined && stock !== before.stock) changes.stock = { from: before.stock, to: stock };
      await this.audit.insertAudit(tx, admin.id, 'product.update', sku, { changes });
      return renderAdminProduct(after);
    });
  }
}
