-- AlterTable
ALTER TABLE `Job` DROP COLUMN `latitude`,
    DROP COLUMN `longitude`,
    ADD COLUMN `mapEmbedUrl` TEXT NULL,
    ADD COLUMN `mapsLink` TEXT NULL;

-- AlterTable
ALTER TABLE `Round` DROP COLUMN `latitude`,
    DROP COLUMN `longitude`,
    ADD COLUMN `mapEmbedUrl` TEXT NULL,
    ADD COLUMN `mapsLink` TEXT NULL;

