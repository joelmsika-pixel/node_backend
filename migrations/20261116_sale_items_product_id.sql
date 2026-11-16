ALTER TABLE sale_items
  ADD COLUMN IF NOT EXISTS product_id BIGINT REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sale_items_product_id_idx
  ON sale_items(product_id) WHERE product_id IS NOT NULL;
