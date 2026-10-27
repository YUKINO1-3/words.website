-- A deleted row's numeric ID may be reused by SQLite. A persistent per-card
-- generation prevents an old browser tab from reviewing a different new card.
ALTER TABLE cards ADD COLUMN epoch TEXT NOT NULL DEFAULT '';
UPDATE cards SET epoch=lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)));
