-- CreateTable
CREATE TABLE `WorkSimulationReview` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `stars` INTEGER NOT NULL,
    `comment` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WorkSimulationReview_runId_key`(`runId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WorkSimulationReview` ADD CONSTRAINT `WorkSimulationReview_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `WorkSimulationRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

