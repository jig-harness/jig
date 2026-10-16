-- The state this migration held when it was applied.
CREATE INDEX orders_status_idx ON orders (status);
