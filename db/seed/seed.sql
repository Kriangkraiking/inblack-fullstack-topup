-- Seed data from spec section 4. Runs on every start, inside one transaction.
-- ON CONFLICT DO NOTHING keeps a re-run from duplicating rows or from resetting live
-- stock, voucher usage and admin edits.

INSERT INTO products (sku, slug, name, price_satang, stock, max_qty_per_order, max_qty_per_email) VALUES
  ('DIAMOND-1000',  'diamond-1000',  '1,000 Diamonds',            34900,  NULL, NULL, NULL),
  ('DIAMOND-5000',  'diamond-5000',  '5,000 Diamonds',            159000, NULL, NULL, NULL),
  ('MONTHLY-PASS',  'monthly-pass',  'Monthly Pass',              17900,  NULL, 1,    NULL),
  ('FLASH-SKIN-01', 'flash-skin-01', 'Limited Skin (Flash Sale)', 9900,   100,  NULL, 2)
ON CONFLICT (sku) DO NOTHING;

-- Card display fields (migration 0013). Fills only empty rows, never price, stock or SKU.
UPDATE products SET
  category = v.category, description = v.description, image_path = v.image_path
FROM (VALUES
  ('DIAMOND-1000',  'currency', '1,000 Diamonds delivered straight to your game account.', '/images/products/diamond-1000.png'),
  ('DIAMOND-5000',  'currency', '5,000 Diamonds delivered straight to your game account.', '/images/products/diamond-5000.png'),
  ('MONTHLY-PASS',  'pass',     '30 days of daily rewards. One per order.',                '/images/products/monthly-pass.png'),
  ('FLASH-SKIN-01', 'skin',     'Limited flash sale skin. Up to 2 per email while stock lasts.', '/images/products/flash-skin-01.png')
) AS v (sku, category, description, image_path)
WHERE products.sku = v.sku AND products.category IS NULL;

INSERT INTO vouchers (code, discount_type, percent_bps, fixed_satang, cap_satang, min_subtotal_satang, max_uses, max_uses_per_email) VALUES
  ('SAVE10', 'PERCENT', 1000, NULL, 5000, 20000, 10,   1),
  ('FLAT20', 'FIXED',   NULL, 2000, NULL, 10000, NULL, NULL)
ON CONFLICT (code) DO NOTHING;

-- Test accounts only. Passwords are listed in docs/SEED_CREDENTIALS.md.
INSERT INTO admin_users (email, password_hash, role) VALUES
  ('viewer@inblackm.test', 'scrypt$16384$8$1$xjiHPOO/t+WLzHItvqpTYg==$LjJ/8Yd76SMxK0dIqGOm77kLrQUiI/H2fsvYMFdWvpU=', 'viewer'),
  ('support@inblackm.test', 'scrypt$16384$8$1$ac71HewSmAXAYshIbzm46A==$81JLNHlaY430BjSdERgaMgUZK3Yic93dy2Ed0CTpF6s=', 'support'),
  ('finance@inblackm.test', 'scrypt$16384$8$1$c/yd+t0MqtKhYifywJB/VQ==$bg9ey0185M0U+kWSwOXUOb7k60gA8T14UyG8xxAl9Uw=', 'finance'),
  ('superadmin@inblackm.test', 'scrypt$16384$8$1$rs++AqSL9Mu3d47DR1mELQ==$G0cVX3DtcHQrf8EYqm7X8I2J4jGp+0eGFneTMLXKEZQ=', 'superadmin')
ON CONFLICT (email) DO NOTHING;

-- Sign-in by username (migration 0011 adds the column and inserts the same row). Repeated here so
-- a test reset brings it back. ON CONFLICT without a target also covers the username index.
INSERT INTO admin_users (email, username, password_hash, role) VALUES
  ('admin@inblackm.test', 'Admin', 'scrypt$16384$8$1$uEdjqmeOQjC26Dsycg97yg==$MQfupWOMcg760C6QreMESitYaQLhC5s8N8EPYzcYzH4=', 'superadmin')
ON CONFLICT DO NOTHING;
