-- 0002: what the Pro pass payment needs beyond the 0001 invoices table (docs/DATABASE.md).
-- merchant_locking_hex: the script the invoice was priced to pay, fixed at creation.
-- expires_at: unix seconds after which an unpaid invoice is no longer offered.
-- abandoned: 1 once an expired invoice's coins were spent elsewhere and no payment was found
--   on a fresh check; it is never rechecked. Its status stays 'expired'.
ALTER TABLE invoices ADD COLUMN merchant_locking_hex TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN abandoned INTEGER NOT NULL DEFAULT 0 CHECK (abandoned IN (0, 1));
CREATE INDEX invoices_account ON invoices(account_id, created_at);
