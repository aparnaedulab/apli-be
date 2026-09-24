-- AlterTable
ALTER TABLE `candidate` ADD COLUMN `accommodations` JSON NULL,
    ADD COLUMN `isPwd` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `openToNightShift` BOOLEAN NULL,
    ADD COLUMN `openToRelocate` BOOLEAN NULL,
    ADD COLUMN `openToTravel` VARCHAR(191) NULL,
    ADD COLUMN `pwdCategories` JSON NULL,
    ADD COLUMN `pwdPct` INTEGER NULL;

