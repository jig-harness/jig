-- The first migration: the table every later one builds on.
CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  status TEXT NOT NULL
);
