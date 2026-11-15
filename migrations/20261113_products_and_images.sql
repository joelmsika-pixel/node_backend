CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  selling_price NUMERIC(12,2) NOT NULL CHECK (selling_price >= 0),
  cost_price NUMERIC(12,2) CHECK (cost_price IS NULL OR cost_price >= 0),
  sku VARCHAR(100),
  category VARCHAR(100) NOT NULL,
  stock_quantity NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT products_id_business_id_unique UNIQUE (id, business_id)
);

CREATE INDEX IF NOT EXISTS products_business_name_idx
  ON products(business_id, name, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS products_business_created_idx
  ON products(business_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS products_business_category_idx
  ON products(business_id, category) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS products_business_stock_idx
  ON products(business_id, stock_quantity) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS products_business_sku_unique_idx
  ON products(business_id, lower(sku)) WHERE sku IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS product_images (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL,
  image_key TEXT NOT NULL UNIQUE,
  thumbnail_key TEXT NOT NULL UNIQUE,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  thumbnail_size_bytes INTEGER NOT NULL CHECK (thumbnail_size_bytes > 0),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT product_images_product_business_fk
    FOREIGN KEY (product_id, business_id)
    REFERENCES products(id, business_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS product_images_business_product_idx
  ON product_images(business_id, product_id, sort_order, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS product_images_deleted_idx
  ON product_images(business_id, id) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_image_cleanup (
  object_key TEXT PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS product_image_cleanup_business_created_idx
  ON product_image_cleanup(business_id, created_at);
