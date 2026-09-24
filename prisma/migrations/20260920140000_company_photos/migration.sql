-- A company's page is what a student reads before applying, so it gets
-- pictures: one banner, and up to six photographs of the office, the team and
-- the work. The photographs are one list, always read and written together.
ALTER TABLE `Company` ADD COLUMN `coverUrl` VARCHAR(191) NULL;

-- Added nullable and filled in before being made NOT NULL. Adding a NOT NULL
-- JSON column outright leaves every existing row holding NULL - MySQL has no
-- implicit default for JSON - which is exactly the state the column is meant
-- to forbid.
ALTER TABLE `Company` ADD COLUMN `photos` JSON NULL;
UPDATE `Company` SET `photos` = JSON_ARRAY() WHERE `photos` IS NULL;
ALTER TABLE `Company` MODIFY COLUMN `photos` JSON NOT NULL;
