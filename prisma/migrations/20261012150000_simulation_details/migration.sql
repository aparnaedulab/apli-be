-- AlterTable
ALTER TABLE `WorkSimulation` ADD COLUMN `about` TEXT NULL,
    ADD COLUMN `coverUrl` VARCHAR(500) NULL,
    ADD COLUMN `videoUrl` VARCHAR(500) NULL;

-- AlterTable
ALTER TABLE `WorkSimulationTask` ADD COLUMN `learn` JSON NOT NULL;

