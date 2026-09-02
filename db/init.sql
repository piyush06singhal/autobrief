-- Mock schema for the weekly business report.
-- Two tables are enough to derive sales, signups, and churn: users and orders.

CREATE TABLE users (
    id           SERIAL PRIMARY KEY,
    email        TEXT NOT NULL UNIQUE,
    signed_up_at TIMESTAMPTZ NOT NULL,
    churned_at   TIMESTAMPTZ
);

CREATE TABLE orders (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    amount     NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_users_signed_up_at ON users (signed_up_at);
CREATE INDEX idx_users_churned_at ON users (churned_at);
CREATE INDEX idx_orders_created_at ON orders (created_at);

-- Seed ~10 weeks of history so the weekly report has trend data to compare against.

-- 1) Signups: 15-40 new users per day over the last 70 days.
INSERT INTO users (email, signed_up_at)
SELECT
    'user' || ROW_NUMBER() OVER (ORDER BY day_offset, gs) || '@example.com',
    NOW() - (day_offset || ' days')::INTERVAL - (random() * INTERVAL '20 hours')
FROM generate_series(0, 69) AS day_offset
CROSS JOIN LATERAL generate_series(1, (15 + floor(random() * 26))::INT) AS gs;

-- 2) Churn: ~3% of users who signed up more than 14 days ago have since churned.
UPDATE users
SET churned_at = signed_up_at + (INTERVAL '14 days') + (random() * INTERVAL '30 days')
WHERE signed_up_at < NOW() - INTERVAL '14 days'
  AND random() < 0.03;

-- Don't let churn dates land in the future.
UPDATE users SET churned_at = NULL WHERE churned_at > NOW();

-- 3) Orders: each user places 0-4 orders spread across the last 70 days.
-- Order count is precomputed per user (rather than inline in generate_series)
-- so it's evaluated exactly once per user, not re-evaluated across the join.
WITH order_counts AS (
    SELECT id, signed_up_at, floor(random() * 5)::INT AS n
    FROM users
)
INSERT INTO orders (user_id, amount, created_at)
SELECT
    oc.id,
    round((20 + random() * 480)::NUMERIC, 2),
    oc.signed_up_at + (random() * LEAST(NOW() - oc.signed_up_at, INTERVAL '70 days'))
FROM order_counts oc
CROSS JOIN LATERAL generate_series(1, oc.n) AS order_num
WHERE oc.n > 0;
