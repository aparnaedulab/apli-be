-- The placement cell's office contact belongs with the placement officer, not
-- with the institution record, so these come back out again. Nothing outside
-- the college form ever read them.
ALTER TABLE `College`
  DROP COLUMN `website`,
  DROP COLUMN `logoUrl`,
  DROP COLUMN `placementEmail`,
  DROP COLUMN `placementPhone`;
