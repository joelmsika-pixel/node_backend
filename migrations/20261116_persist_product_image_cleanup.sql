ALTER TABLE product_image_cleanup
  ALTER COLUMN business_id DROP NOT NULL;

ALTER TABLE product_image_cleanup
  DROP CONSTRAINT IF EXISTS product_image_cleanup_business_id_fkey;

ALTER TABLE product_image_cleanup
  ADD CONSTRAINT product_image_cleanup_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE SET NULL;
