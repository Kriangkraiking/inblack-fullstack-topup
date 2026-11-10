-- Display fields for the product cards of the redesigned store. Not used by pricing, stock or
-- limits. NULL is allowed so a product added later without them still works.
-- image_path is a path on the web app (served from apps/web/public), never an outside URL.

ALTER TABLE products
  ADD COLUMN category    text CHECK (category IS NULL OR category ~ '^[a-z][a-z-]{0,31}$'),
  ADD COLUMN description text CHECK (description IS NULL OR (description <> '' AND length(description) <= 500)),
  ADD COLUMN image_path  text CHECK (image_path IS NULL OR image_path ~ '^/[A-Za-z0-9/._-]{1,200}$');

-- Same values as db/seed/seed.sql, which fills them again after a test reset. Only rows still
-- empty are touched; price, stock and SKU are not.
UPDATE products SET
  category = v.category, description = v.description, image_path = v.image_path
FROM (VALUES
  ('DIAMOND-1000',  'currency', '1,000 Diamonds delivered straight to your game account.', '/images/products/diamond-1000.png'),
  ('DIAMOND-5000',  'currency', '5,000 Diamonds delivered straight to your game account.', '/images/products/diamond-5000.png'),
  ('MONTHLY-PASS',  'pass',     '30 days of daily rewards. One per order.',                '/images/products/monthly-pass.png'),
  ('FLASH-SKIN-01', 'skin',     'Limited flash sale skin. Up to 2 per email while stock lasts.', '/images/products/flash-skin-01.png')
) AS v (sku, category, description, image_path)
WHERE products.sku = v.sku AND products.category IS NULL;
