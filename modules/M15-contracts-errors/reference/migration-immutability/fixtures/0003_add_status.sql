-- A new migration: the right way to change what 0002 built.
DROP INDEX orders_status_idx;
CREATE INDEX orders_status_idx ON orders (status) WHERE status <> 'closed';
