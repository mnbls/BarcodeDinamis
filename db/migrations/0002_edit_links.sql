-- Link edit tanpa login + barcode yang tujuannya belum diisi.
--
--  * barcodes.target_url boleh NULL: barcode dibuat kosong, tujuannya diisi nanti. Constraint CHECK yang
--    sudah ada (skema http/https/mailto/tel, panjang maksimum) tetap berlaku untuk nilai yang diisi,
--    karena CHECK meloloskan NULL.
--  * barcodes.edit_token: rahasia acak (256 bit) di dalam link edit /e/{token}. Siapa pun yang memegang
--    link itu bisa mengubah TUJUAN barcode tersebut, dan hanya itu. NULL = tidak ada link (dicabut, atau
--    barcode lama yang belum dibuatkan link). Barcode yang sudah ada sengaja TIDAK diberi token otomatis.
--  * barcode_history mencatat lewat mana sebuah perubahan dibuat (admin atau link edit) dan dari IP mana.

ALTER TABLE barcodes ALTER COLUMN target_url DROP NOT NULL;

ALTER TABLE barcodes
  ADD COLUMN edit_token VARCHAR(64),
  ADD CONSTRAINT barcodes_edit_token_check CHECK (edit_token IS NULL OR edit_token ~ '^[A-Za-z0-9_-]{32,64}$');

CREATE UNIQUE INDEX barcodes_edit_token_uidx ON barcodes (edit_token) WHERE edit_token IS NOT NULL;

ALTER TABLE barcode_history
  ADD COLUMN changed_via VARCHAR(12) NOT NULL DEFAULT 'admin',
  ADD COLUMN changed_ip  INET,
  ADD CONSTRAINT barcode_history_via_check CHECK (changed_via IN ('admin', 'edit_link'));
