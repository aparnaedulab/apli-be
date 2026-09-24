-- AlterTable
ALTER TABLE `Job` ADD COLUMN `addressLine` TEXT NULL,
    ADD COLUMN `latitude` DECIMAL(10, 7) NULL,
    ADD COLUMN `longitude` DECIMAL(10, 7) NULL,
    ADD COLUMN `pincode` VARCHAR(191) NULL;

