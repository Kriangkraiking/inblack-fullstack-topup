import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { CurrentAdmin, RequireRole, type Admin } from '../admin/admin-roles.js';
import { parseWith } from '../common/validate.js';
import { AdminProductsService } from './admin-products.service.js';
import { productPatchSchema, skuSchema } from './product-edit.js';

/**
 * superadmin only (spec 3). CSRF is the global guard's: a PATCH with the admin cookie must come
 * from an allowed Origin. GET /products keeps its 15 second cache, so the catalogue can show the
 * old values for up to 15 seconds after a change.
 */
@Controller('api/v1/admin/products')
export class AdminProductsController {
  constructor(private readonly products: AdminProductsService) {}

  @Get()
  @RequireRole('superadmin')
  list() {
    return this.products.list();
  }

  @Patch(':sku')
  @RequireRole('superadmin')
  update(@CurrentAdmin() admin: Admin, @Param('sku') sku: string, @Body() body: unknown) {
    const validSku = parseWith(skuSchema, sku, { status: 404, codeFor: () => 'PRODUCT_NOT_FOUND' });
    return this.products.update(admin, validSku, parseWith(productPatchSchema, body));
  }
}
