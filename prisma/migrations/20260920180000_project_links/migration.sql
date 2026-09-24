-- A project is routinely in several places at once: the repository, a live
-- demo, a write-up, a video of it running. One `link` column made a student
-- pick which of those a recruiter got to see.

-- Added nullable and filled in before being made NOT NULL. Adding a NOT NULL
-- JSON column outright leaves every existing row holding NULL - MySQL has no
-- implicit default for JSON - which is exactly the state the column forbids.
ALTER TABLE `Project` ADD COLUMN `links` JSON NULL;

-- Whatever was already on record becomes the first link, so nothing a student
-- had entered is lost to the change.
UPDATE `Project`
SET `links` = JSON_ARRAY(JSON_OBJECT('url', `link`))
WHERE `link` IS NOT NULL AND TRIM(`link`) <> '';

UPDATE `Project` SET `links` = JSON_ARRAY() WHERE `links` IS NULL;
ALTER TABLE `Project` MODIFY COLUMN `links` JSON NOT NULL;

ALTER TABLE `Project` DROP COLUMN `link`;
