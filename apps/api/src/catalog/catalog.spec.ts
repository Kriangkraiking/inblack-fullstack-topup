import { renderProduct } from './catalog.service.js';

const ROW = {
  sku: 'FLASH-SKIN-01',
  slug: 'flash-skin-01',
  name: 'Limited Skin (Flash Sale)',
  price_satang: '9900',
  stock: 100,
  max_qty_per_order: null,
  max_qty_per_email: 2,
  category: 'skin',
  description: 'Limited flash sale skin.',
  image_path: '/images/products/flash-skin-01.png',
};

describe('renderProduct', () => {
  it('keeps every original field and adds the card fields', () => {
    expect(renderProduct(ROW)).toEqual({
      sku: 'FLASH-SKIN-01',
      slug: 'flash-skin-01',
      name: 'Limited Skin (Flash Sale)',
      price_satang: 9900,
      stock: 100,
      max_qty_per_order: null,
      max_qty_per_email: 2,
      category: 'skin',
      description: 'Limited flash sale skin.',
      image_path: '/images/products/flash-skin-01.png',
    });
  });

  it('passes null card fields through for a product without them', () => {
    const out = renderProduct({ ...ROW, category: null, description: null, image_path: null });
    expect(out).toMatchObject({ category: null, description: null, image_path: null, price_satang: 9900 });
  });
});
