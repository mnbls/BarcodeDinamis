-- Barcode "Ulasan Google Maps": the destination is the "write a review" page of a Google Maps place.
--
--  * barcodes.maps_place_id  = the place's Place ID ("ChIJ..."), the PRIMARY data. The review link is derived from it
--    (lib/google-maps.js), so if Google ever changes the link format it is rebuilt from here
--    (scripts/rebuild-review-urls.js) and nobody has to paste a Maps link again.
--  * barcodes.maps_source_url = the Google Maps link the person pasted (supplementary: shown to the admin, and lets an
--    unchanged link be recognised without contacting Google again).
--  * barcodes.target_url keeps holding the address the redirect endpoint sends visitors to (here: the review link), so
--    the hot path /b/{code}, the list, the export and the history do not need to know about Maps at all.
--
-- Nothing changes for existing rows: they keep their type and have no Place ID.

ALTER TABLE barcodes DROP CONSTRAINT barcodes_target_type_check;
ALTER TABLE barcodes ADD CONSTRAINT barcodes_target_type_check
  CHECK (target_type IN ('url', 'whatsapp', 'email', 'phone', 'maps_review'));

ALTER TABLE barcodes
  ADD COLUMN maps_place_id   VARCHAR(40),
  ADD COLUMN maps_source_url TEXT,
  ADD CONSTRAINT barcodes_maps_place_id_check  CHECK (maps_place_id IS NULL OR maps_place_id ~ '^ChIJ[A-Za-z0-9_-]{23}$'),
  ADD CONSTRAINT barcodes_maps_source_len_check CHECK (maps_source_url IS NULL OR char_length(maps_source_url) <= 2048),
  -- A Place ID exists exactly when the barcode is a filled-in "maps_review" one: the two can never disagree.
  ADD CONSTRAINT barcodes_maps_consistency_check
    CHECK ((target_type = 'maps_review' AND target_url IS NOT NULL) = (maps_place_id IS NOT NULL));
