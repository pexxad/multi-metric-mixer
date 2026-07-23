CREATE TABLE sales (
  id integer PRIMARY KEY,
  order_id text NOT NULL UNIQUE,
  region_id integer NOT NULL,
  product_id text NOT NULL,
  category text NOT NULL,
  amount numeric(12, 2) NOT NULL,
  quantity integer NOT NULL,
  customer_segment text NOT NULL,
  sales_channel text NOT NULL,
  status text NOT NULL,
  discount_rate numeric(5, 2),
  sales_rep text,
  sold_at timestamptz NOT NULL
);

INSERT INTO sales
  (id, order_id, region_id, product_id, category, amount, quantity, customer_segment, sales_channel, status, discount_rate, sales_rep, sold_at)
VALUES
  (1,  'ORD-2026-001', 101, 'HW-LAPTOP',  'Hardware', 1280.00, 2,  'Enterprise', 'Direct',      'completed', 0.05, 'A. Sato',    '2026-04-02T09:15:00Z'),
  (2,  'ORD-2026-002', 102, 'SW-ANALYTICS','Software',  920.00, 10, 'Mid-market', 'Partner',     'completed', 0.10, 'M. Tanaka',  '2026-04-03T01:20:00Z'),
  (3,  'ORD-2026-003', 103, 'SV-CONSULT',  'Services',  760.00, 4,  'Enterprise', 'Direct',      'completed', NULL, 'K. Suzuki',  '2026-04-05T06:40:00Z'),
  (4,  'ORD-2026-004', 104, 'HW-MONITOR',  'Hardware',  540.00, 3,  'SMB',        'Online',      'completed', 0.00, 'Y. Ito',     '2026-04-08T11:05:00Z'),
  (5,  'ORD-2026-005', 105, 'SW-SECURITY', 'Software', 1120.00, 8,  'Enterprise', 'Partner',     'completed', 0.08, 'R. Yamamoto','2026-04-12T03:35:00Z'),
  (6,  'ORD-2026-006', 106, 'SV-SUPPORT',  'Services',  430.00, 1,  'SMB',        'Online',      'refunded',  0.00, NULL,         '2026-04-15T08:55:00Z'),
  (7,  'ORD-2026-007', 101, 'SW-ANALYTICS','Software', 1540.00, 14, 'Enterprise', 'Direct',      'completed', 0.12, 'A. Sato',    '2026-04-21T02:10:00Z'),
  (8,  'ORD-2026-008', 102, 'HW-MONITOR',  'Hardware',  610.00, 4,  'Mid-market', 'Online',      'completed', 0.05, 'M. Tanaka',  '2026-04-24T12:45:00Z'),
  (9,  'ORD-2026-009', 103, 'SW-SECURITY', 'Software',  880.00, 6,  'SMB',        'Partner',     'pending',   NULL, 'K. Suzuki',  '2026-05-01T07:25:00Z'),
  (10, 'ORD-2026-010', 104, 'SV-CONSULT',  'Services', 1380.00, 6,  'Enterprise', 'Direct',      'completed', 0.03, 'Y. Ito',     '2026-05-04T04:30:00Z'),
  (11, 'ORD-2026-011', 105, 'HW-LAPTOP',   'Hardware', 1890.00, 3,  'Mid-market', 'Partner',     'completed', 0.07, 'R. Yamamoto','2026-05-07T10:15:00Z'),
  (12, 'ORD-2026-012', 106, 'SW-ANALYTICS','Software',  680.00, 5,  'SMB',        'Online',      'completed', 0.00, NULL,         '2026-05-10T00:50:00Z'),
  (13, 'ORD-2026-013', 101, 'SV-SUPPORT',  'Services',  590.00, 2,  'Enterprise', 'Direct',      'completed', NULL, 'A. Sato',    '2026-05-13T05:40:00Z'),
  (14, 'ORD-2026-014', 102, 'SW-SECURITY', 'Software', 1240.00, 9,  'Enterprise', 'Partner',     'completed', 0.09, 'M. Tanaka',  '2026-05-18T09:05:00Z'),
  (15, 'ORD-2026-015', 103, 'HW-MONITOR',  'Hardware',  720.00, 5,  'Mid-market', 'Online',      'completed', 0.04, 'K. Suzuki',  '2026-05-22T02:35:00Z'),
  (16, 'ORD-2026-016', 104, 'SW-ANALYTICS','Software', 1650.00, 15, 'Enterprise', 'Direct',      'completed', 0.15, 'Y. Ito',     '2026-05-27T06:10:00Z'),
  (17, 'ORD-2026-017', 105, 'SV-CONSULT',  'Services',  970.00, 5,  'SMB',        'Partner',     'refunded',  0.05, 'R. Yamamoto','2026-06-02T11:45:00Z'),
  (18, 'ORD-2026-018', 106, 'HW-LAPTOP',   'Hardware', 1360.00, 2,  'Enterprise', 'Direct',      'completed', 0.02, NULL,         '2026-06-05T03:20:00Z'),
  (19, 'ORD-2026-019', 101, 'SW-SECURITY', 'Software', 1080.00, 8,  'Mid-market', 'Online',      'completed', 0.06, 'A. Sato',    '2026-06-09T08:30:00Z'),
  (20, 'ORD-2026-020', 102, 'SV-SUPPORT',  'Services',  510.00, 2,  'SMB',        'Online',      'pending',   NULL, 'M. Tanaka',  '2026-06-12T01:55:00Z'),
  (21, 'ORD-2026-021', 103, 'SW-ANALYTICS','Software', 1420.00, 12, 'Enterprise', 'Partner',     'completed', 0.10, 'K. Suzuki',  '2026-06-15T07:10:00Z'),
  (22, 'ORD-2026-022', 104, 'HW-MONITOR',  'Hardware',  660.00, 4,  'Mid-market', 'Direct',      'completed', 0.03, 'Y. Ito',     '2026-06-18T04:25:00Z'),
  (23, 'ORD-2026-023', 105, 'SV-CONSULT',  'Services', 1520.00, 7,  'Enterprise', 'Direct',      'completed', 0.04, 'R. Yamamoto','2026-06-21T10:40:00Z'),
  (24, 'ORD-2026-024', 106, 'SW-SECURITY', 'Software',  790.00, 5,  'SMB',        'Online',      'completed', 0.00, NULL,         '2026-06-25T00:35:00Z'),
  (25, 'ORD-2026-025', 101, 'HW-LAPTOP',   'Hardware', 2110.00, 3,  'Enterprise', 'Partner',     'completed', 0.08, 'A. Sato',    '2026-07-01T05:50:00Z'),
  (26, 'ORD-2026-026', 102, 'SW-ANALYTICS','Software', 1170.00, 10, 'Mid-market', 'Direct',      'completed', 0.05, 'M. Tanaka',  '2026-07-03T09:15:00Z'),
  (27, 'ORD-2026-027', 103, 'SV-SUPPORT',  'Services',  640.00, 3,  'SMB',        'Partner',     'completed', NULL, 'K. Suzuki',  '2026-07-06T02:45:00Z'),
  (28, 'ORD-2026-028', 104, 'SW-SECURITY', 'Software', 1730.00, 13, 'Enterprise', 'Direct',      'completed', 0.11, 'Y. Ito',     '2026-07-09T06:05:00Z'),
  (29, 'ORD-2026-029', 105, 'HW-MONITOR',  'Hardware',  830.00, 5,  'Mid-market', 'Online',      'pending',   0.02, 'R. Yamamoto','2026-07-12T11:25:00Z'),
  (30, 'ORD-2026-030', 106, 'SV-CONSULT',  'Services', 1210.00, 6,  'Enterprise', 'Partner',     'completed', 0.06, NULL,         '2026-07-16T03:40:00Z');

CREATE USER mmm_reader WITH PASSWORD 'local-postgres-reader';
GRANT CONNECT ON DATABASE metrics TO mmm_reader;
GRANT USAGE ON SCHEMA public TO mmm_reader;
GRANT SELECT ON TABLE sales TO mmm_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mmm_reader;
