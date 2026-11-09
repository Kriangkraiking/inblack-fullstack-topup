-- Catalogue, vouchers and admin users. All money is bigint satang.

CREATE TABLE products (
  sku               text PRIMARY KEY,
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL CHECK (name <> ''),
  price_satang      bigint NOT NULL CHECK (price_satang >= 0),
  -- NULL means unlimited. The CHECK is the last line of defence against oversell.
  stock             integer CONSTRAINT products_stock_not_negative CHECK (stock IS NULL OR stock >= 0),
  max_qty_per_order integer CHECK (max_qty_per_order IS NULL OR max_qty_per_order > 0),
  max_qty_per_email integer CHECK (max_qty_per_email IS NULL OR max_qty_per_email > 0),
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vouchers (
  code                text PRIMARY KEY CHECK (code = upper(code) AND code <> ''),
  discount_type       text NOT NULL CHECK (discount_type IN ('PERCENT', 'FIXED')),
  percent_bps         integer CHECK (percent_bps BETWEEN 1 AND 10000),
  fixed_satang        bigint CHECK (fixed_satang >= 0),
  cap_satang          bigint CHECK (cap_satang >= 0),
  min_subtotal_satang bigint NOT NULL DEFAULT 0 CHECK (min_subtotal_satang >= 0),
  max_uses            integer CHECK (max_uses >= 0),
  used_count          integer NOT NULL DEFAULT 0,
  -- Enforced by a unique index on voucher_redemptions, which can only express "one".
  max_uses_per_email  integer CHECK (max_uses_per_email = 1),
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vouchers_shape CHECK (
    (discount_type = 'PERCENT' AND percent_bps IS NOT NULL AND fixed_satang IS NULL)
    OR (discount_type = 'FIXED' AND fixed_satang IS NOT NULL AND percent_bps IS NULL AND cap_satang IS NULL)
  ),
  CONSTRAINT vouchers_used_within_limit CHECK (
    used_count >= 0 AND (max_uses IS NULL OR used_count <= max_uses)
  )
);

CREATE TABLE admin_users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  -- Format: scrypt$N$r$p$<salt base64>$<hash base64>, see docs/SEED_CREDENTIALS.md
  password_hash text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  role          text NOT NULL CHECK (role IN ('viewer', 'support', 'finance', 'superadmin')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
