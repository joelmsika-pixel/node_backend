CREATE TABLE IF NOT EXISTS pc_inspection_reports (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  business_name VARCHAR(200) NOT NULL,
  prepared_by_name VARCHAR(150) NOT NULL,
  device_count INTEGER NOT NULL CHECK (device_count > 0),
  devices JSONB NOT NULL CHECK (jsonb_typeof(devices) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS pc_inspection_reports_business_created_idx
  ON pc_inspection_reports (business_id, created_at DESC, id DESC);
