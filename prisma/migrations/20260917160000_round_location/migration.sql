-- AlterTable
ALTER TABLE `Round` ADD COLUMN `addressLine` TEXT NULL,
    ADD COLUMN `isOnline` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `latitude` DECIMAL(10, 7) NULL,
    ADD COLUMN `longitude` DECIMAL(10, 7) NULL,
    ADD COLUMN `meetingLink` TEXT NULL,
    ADD COLUMN `pincode` VARCHAR(191) NULL;

