-- A fuller college profile. `code` and `state` become required, so existing
-- rows are backfilled first: the code from the row id (the seed replaces these
-- with real short forms), the state from the only one currently represented.

ALTER TABLE `College`
  ADD COLUMN `code`           VARCHAR(191) NULL,
  ADD COLUMN `affiliation`    VARCHAR(191) NULL,
  ADD COLUMN `state`          VARCHAR(191) NULL,
  ADD COLUMN `address`        TEXT         NULL,
  ADD COLUMN `pincode`        VARCHAR(191) NULL,
  ADD COLUMN `website`        VARCHAR(191) NULL,
  ADD COLUMN `logoUrl`        VARCHAR(191) NULL,
  ADD COLUMN `placementEmail` VARCHAR(191) NULL,
  ADD COLUMN `placementPhone` VARCHAR(191) NULL,
  ADD COLUMN `naacGrade`      VARCHAR(191) NULL;

-- cuid ids share a leading prefix, so the whole id is used: ugly but unique.
-- The seed replaces these with real short forms (PICT, VIT, COEP).
UPDATE `College` SET `code`  = UPPER(`id`)   WHERE `code`  IS NULL;
UPDATE `College` SET `state` = 'Maharashtra'                WHERE `state` IS NULL;
UPDATE `College` SET `city`  = 'Unknown'                    WHERE `city`  IS NULL;

ALTER TABLE `College`
  MODIFY COLUMN `code`  VARCHAR(191) NOT NULL,
  MODIFY COLUMN `state` VARCHAR(191) NOT NULL,
  MODIFY COLUMN `city`  VARCHAR(191) NOT NULL;

-- A unique short code replaces the brittle name+city pair.
DROP INDEX `College_name_city_key` ON `College`;
CREATE UNIQUE INDEX `College_code_key` ON `College`(`code`);
CREATE INDEX `College_city_idx` ON `College`(`city`);
