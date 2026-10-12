-- AlterTable
ALTER TABLE `WorkSimulationTask` ADD COLUMN `pages` JSON NOT NULL;

-- Tasks written before this have no pages yet: an empty list, not null.
UPDATE `WorkSimulationTask` SET `pages` = JSON_ARRAY();

-- CreateTable
CREATE TABLE `WorkSimulationCheckAnswer` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `pageId` VARCHAR(40) NOT NULL,
    `answers` JSON NOT NULL,
    `score` INTEGER NOT NULL,
    `total` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WorkSimulationCheckAnswer_runId_taskId_pageId_key`(`runId`, `taskId`, `pageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WorkSimulationCheckAnswer` ADD CONSTRAINT `WorkSimulationCheckAnswer_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `WorkSimulationRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkSimulationCheckAnswer` ADD CONSTRAINT `WorkSimulationCheckAnswer_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `WorkSimulationTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

