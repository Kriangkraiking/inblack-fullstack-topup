import { Module, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import request from 'supertest';
import { AdminAuthGuard, SESSION_COOKIE } from '../admin/admin-auth.guard.js';
import { AdminAuthRepository } from '../admin/admin-auth.repository.js';
import { AdminAuthService } from '../admin/admin-auth.service.js';
import type { Admin } from '../admin/admin-roles.js';
import { ProblemError } from '../common/problem.js';
import { ProblemFilter } from '../common/problem.filter.js';
import { CsrfGuard } from '../security/csrf.guard.js';
import { AdminProductsController } from './admin-products.controller.js';
import { AdminProductsRepository, type AdminProductRow } from './admin-products.repository.js';
import { AdminProductsService } from './admin-products.service.js';
import { decideStock, productPatchSchema } from './product-edit.js';

describe('productPatchSchema', () => {
  const ok = (body: unknown) => productPatchSchema.safeParse(body).success;

  it.each([
    [{ name: 'New name' }],
    [{ price_satang: 1 }],
    [{ price_satang: 100_000_000 }],
    [{ stock: 0, expected_stock: 5 }],
    [{ stock: null, expected_stock: null }],
    [{ name: '<img src=x onerror=alert(1)>' }],
  ])('accepts %j', (body) => {
    expect(ok(body)).toBe(true);
  });

  it.each([
    [{}],
    [{ price_satang: 0 }],
    [{ price_satang: -100 }],
    [{ price_satang: 99.5 }],
    [{ price_satang: '34900' }],
    [{ price_satang: 100_000_001 }],
    [{ stock: -1, expected_stock: 0 }],
    [{ stock: 1.5, expected_stock: 0 }],
    [{ stock: 10 }],
    [{ name: '' }],
    [{ name: '   ' }],
    [{ name: 'a'.repeat(121) }],
    [{ name: 'line\nbreak' }],
    [{ name: 'ok', slug: 'changed' }],
    [{ name: 'ok', active: false }],
  ])('refuses %j', (body) => {
    expect(ok(body)).toBe(false);
  });

  it('trims the name', () => {
    expect(productPatchSchema.parse({ name: '  Skin  ' }).name).toBe('Skin');
  });
});

describe('decideStock', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 'none';
    } catch (error) {
      return (error as ProblemError).code;
    }
  };

  it('leaves stock alone when the patch does not name it', () => {
    expect(decideStock(7, {})).toBeUndefined();
  });

  it('writes the new value when the admin saw the current one', () => {
    expect(decideStock(7, { stock: 50, expected_stock: 7 })).toBe(50);
    expect(decideStock(7, { stock: 0, expected_stock: 7 })).toBe(0);
    expect(decideStock(null, { stock: null, expected_stock: null })).toBeNull();
  });

  it('refuses when an order changed stock since the admin read it', () => {
    expect(code(() => decideStock(6, { stock: 50, expected_stock: 7 }))).toBe('STOCK_CHANGED');
  });

  it('refuses switching between limited and unlimited', () => {
    expect(code(() => decideStock(null, { stock: 100, expected_stock: null }))).toBe('STOCK_MODE_LOCKED');
    expect(code(() => decideStock(100, { stock: null, expected_stock: 100 }))).toBe('STOCK_MODE_LOCKED');
  });
});

const FLASH: AdminProductRow = {
  sku: 'FLASH-SKIN-01',
  slug: 'flash-skin-01',
  name: 'Limited Skin (Flash Sale)',
  price_satang: '9900',
  stock: 100,
  max_qty_per_order: null,
  max_qty_per_email: 2,
  active: true,
  updated_at: new Date('2026-11-10T00:00:00Z'),
};

/** Holds one row; update() applies the same condition as the SQL (stock unchanged since read). */
class FakeProductsRepository {
  row: AdminProductRow = { ...FLASH };
  audits: { action: string; target: string | null; detail: Record<string, unknown> }[] = [];
  /** Simulates an order taking stock between lock() and update(), which the lock prevents in SQL. */
  raceTake = 0;

  transaction<T>(work: (tx: never) => Promise<T>) {
    const saved = { ...this.row };
    const audits = this.audits.length;
    return work(undefined as never).catch((error: unknown) => {
      this.row = saved;
      this.audits.length = audits;
      throw error;
    });
  }

  list() {
    return Promise.resolve([this.row]);
  }

  lock(_tx: never, sku: string) {
    return Promise.resolve(sku === this.row.sku ? { ...this.row } : undefined);
  }

  update(_tx: never, _sku: string, change: { name?: string; priceSatang?: number; stock?: number | null }, stockRead: number | null) {
    if (this.raceTake && this.row.stock !== null) this.row.stock -= this.raceTake;
    if (this.row.stock !== stockRead) return Promise.resolve(undefined);
    this.row = {
      ...this.row,
      name: change.name ?? this.row.name,
      price_satang: change.priceSatang !== undefined ? String(change.priceSatang) : this.row.price_satang,
      stock: change.stock !== undefined ? change.stock : this.row.stock,
    };
    return Promise.resolve({ ...this.row });
  }

  insertAudit(_tx: never, _adminId: string, action: string, target: string | null, detail: Record<string, unknown>) {
    this.audits.push({ action, target, detail });
    return Promise.resolve();
  }
}

describe('admin products API', () => {
  let app: INestApplication;
  let repository: FakeProductsRepository;
  let current: Admin | undefined;
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const cookie = `${SESSION_COOKIE}=${'a'.repeat(43)}`;
  const ORIGIN = 'http://localhost:3000';
  const as = (role: Admin['role']) => {
    current = { id: '9', email: `${role}@inblackm.test`, role };
  };
  const patch = (body: unknown, sku = 'FLASH-SKIN-01') =>
    request(server())
      .patch(`/api/v1/admin/products/${sku}`)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .send(body as object);

  beforeEach(async () => {
    repository = new FakeProductsRepository();
    current = undefined;
    @Module({
      controllers: [AdminProductsController],
      providers: [
        AdminProductsService,
        { provide: AdminProductsRepository, useValue: repository },
        { provide: AdminAuthRepository, useValue: repository },
        { provide: AdminAuthService, useValue: { authenticate: () => Promise.resolve(current) } },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: AdminAuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    })
    class ProductsModule {}
    app = await NestFactory.create(ProductsModule, { logger: false });
    await app.init();
  });

  afterEach(() => app.close());

  it.each(['viewer', 'support', 'finance'] as const)('%s gets 403 on list and PATCH, and nothing changes', async (role) => {
    as(role);
    const list = await request(server()).get('/api/v1/admin/products').set('Cookie', cookie);
    const change = await patch({ name: 'hacked' });
    expect(list.status).toBe(403);
    expect(change.status).toBe(403);
    expect(change.headers['content-type']).toContain('application/problem+json');
    expect(repository.row.name).toBe(FLASH.name);
    expect(repository.audits).toHaveLength(0);
  });

  it('401 without a session', async () => {
    const response = await request(server()).patch('/api/v1/admin/products/FLASH-SKIN-01').send({ name: 'x' });
    expect(response.status).toBe(401);
  });

  it('superadmin lists products with integer satang', async () => {
    as('superadmin');
    const response = await request(server()).get('/api/v1/admin/products').set('Cookie', cookie).expect(200);
    const body = response.body as { items: { sku: string; price_satang: number }[] };
    expect(body.items[0]).toMatchObject({ sku: 'FLASH-SKIN-01', price_satang: 9900 });
  });

  it('superadmin changes name, price and stock in one audited write', async () => {
    as('superadmin');
    const response = await patch({ name: 'Skin v2', price_satang: 12900, stock: 80, expected_stock: 100 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ name: 'Skin v2', price_satang: 12900, stock: 80 });
    expect(repository.audits).toEqual([
      {
        action: 'product.update',
        target: 'FLASH-SKIN-01',
        detail: {
          changes: {
            name: { from: FLASH.name, to: 'Skin v2' },
            price_satang: { from: 9900, to: 12900 },
            stock: { from: 100, to: 80 },
          },
        },
      },
    ]);
  });

  it('keeps markup in the name as text, byte for byte', async () => {
    as('superadmin');
    const name = '<img src=x onerror=alert(1)>';
    const response = await patch({ name });
    expect(response.status).toBe(200);
    expect((response.body as { name: string }).name).toBe(name);
  });

  it('a stale expected_stock gets 409 STOCK_CHANGED and writes nothing', async () => {
    as('superadmin');
    repository.row.stock = 97;
    const response = await patch({ stock: 200, expected_stock: 100, name: 'should not stick' });
    expect(response.status).toBe(409);
    expect((JSON.parse(response.text) as { code: string }).code).toBe('STOCK_CHANGED');
    expect(repository.row).toMatchObject({ stock: 97, name: FLASH.name });
    expect(repository.audits).toHaveLength(0);
  });

  it('a sale between read and write fails the conditional update and rolls back', async () => {
    as('superadmin');
    repository.raceTake = 1;
    const response = await patch({ stock: 200, expected_stock: 100 });
    expect(response.status).toBe(409);
    expect(repository.audits).toHaveLength(0);
  });

  it.each([
    [{ price_satang: 0 }, 422],
    [{ price_satang: 12.5 }, 422],
    [{ stock: -1, expected_stock: 100 }, 422],
    [{ stock: null, expected_stock: 100 }, 409],
    [{}, 422],
  ])('PATCH %j answers %d problem+json', async (body, status) => {
    as('superadmin');
    const response = await patch(body);
    expect(response.status).toBe(status);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(repository.row.price_satang).toBe('9900');
  });

  it('unknown or malformed sku: 404 PRODUCT_NOT_FOUND', async () => {
    as('superadmin');
    for (const sku of ['NOPE-1', 'bad%20sku']) {
      const response = await patch({ name: 'x' }, sku);
      expect(response.status).toBe(404);
      expect((JSON.parse(response.text) as { code: string }).code).toBe('PRODUCT_NOT_FOUND');
    }
  });

  it('a PATCH from a foreign Origin is refused by the CSRF guard', async () => {
    as('superadmin');
    const response = await request(server())
      .patch('/api/v1/admin/products/FLASH-SKIN-01')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send({ name: 'csrf' });
    expect(response.status).toBe(403);
    expect((JSON.parse(response.text) as { code: string }).code).toBe('CSRF_ORIGIN_MISMATCH');
    expect(repository.row.name).toBe(FLASH.name);
  });
});
