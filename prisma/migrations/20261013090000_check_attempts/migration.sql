-- AlterTable
ALTER TABLE `WorkSimulationCheckAnswer` ADD COLUMN `revealedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `WorkSimulationCheckAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `pageId` VARCHAR(40) NOT NULL,
    `number` INTEGER NOT NULL,
    `answers` JSON NOT NULL,
    `score` INTEGER NOT NULL,
    `total` INTEGER NOT NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WorkSimulationCheckAttempt_sentAt_idx`(`sentAt`),
    UNIQUE INDEX `WorkSimulationCheckAttempt_runId_taskId_pageId_number_key`(`runId`, `taskId`, `pageId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WorkSimulationCheckAttempt` ADD CONSTRAINT `WorkSimulationCheckAttempt_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `WorkSimulationRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkSimulationCheckAttempt` ADD CONSTRAINT `WorkSimulationCheckAttempt_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `WorkSimulationTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Answers given before attempts were kept become each test's first try.
INSERT INTO `WorkSimulationCheckAttempt` (`id`, `runId`, `taskId`, `pageId`, `number`, `answers`, `score`, `total`, `createdAt`)
SELECT CONCAT('a', SUBSTRING(MD5(`id`), 1, 24)), `runId`, `taskId`, `pageId`, 1, `answers`, `score`, `total`, `updatedAt`
FROM `WorkSimulationCheckAnswer`;
