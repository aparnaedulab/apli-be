-- AlterTable
ALTER TABLE `Job` ADD COLUMN `accommodations` JSON NULL,
    ADD COLUMN `genderEligibility` VARCHAR(191) NOT NULL DEFAULT 'ANY',
    ADD COLUMN `genderNote` TEXT NULL,
    ADD COLUMN `inclusionNote` TEXT NULL,
    ADD COLUMN `pwdCategories` JSON NULL,
    ADD COLUMN `pwdSuitable` VARCHAR(191) NULL,
    ADD COLUMN `relocationRequired` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `shift` VARCHAR(191) NULL,
    ADD COLUMN `travel` VARCHAR(191) NULL;

