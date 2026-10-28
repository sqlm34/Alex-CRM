-- ZIP-approved phone bookings collect an address without requiring geocoding.
-- Keep unknown coordinates NULL rather than inventing a map location.
ALTER TABLE jobs ALTER COLUMN lat DROP NOT NULL;
ALTER TABLE jobs ALTER COLUMN lng DROP NOT NULL;
