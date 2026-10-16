-- An illegal edit of an applied migration: content it never held before.
CREATE INDEX orders_status_idx ON orders (status) WHERE status <> 'closed';
