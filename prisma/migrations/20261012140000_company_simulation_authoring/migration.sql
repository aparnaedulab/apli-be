-- AlterTable
ALTER TABLE `WorkSimulation` ADD COLUMN `createdById` VARCHAR(191) NULL,
    ADD COLUMN `reviewNote` TEXT NULL,
    ADD COLUMN `reviewedAt` DATETIME(3) NULL,
    ADD COLUMN `submittedAt` DATETIME(3) NULL,
    MODIFY `status` ENUM('DRAFT', 'SUBMITTED', 'CHANGES_ASKED', 'LIVE', 'RETIRED') NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE `WorkSimulationTask` ADD COLUMN `handIn` TEXT NULL;

