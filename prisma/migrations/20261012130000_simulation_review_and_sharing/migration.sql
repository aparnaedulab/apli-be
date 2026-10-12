-- AlterTable
ALTER TABLE `WorkSimulationRun` ADD COLUMN `explainChange` TEXT NULL,
    ADD COLUMN `explainHow` TEXT NULL,
    ADD COLUMN `reviewNote` TEXT NULL,
    ADD COLUMN `reviewedAt` DATETIME(3) NULL,
    ADD COLUMN `reviewedById` VARCHAR(191) NULL,
    ADD COLUMN `submittedAt` DATETIME(3) NULL,
    MODIFY `status` ENUM('ACTIVE', 'IN_REVIEW', 'NEEDS_WORK', 'COMPLETED', 'LEFT') NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE `WorkSimulationTaskDone` ADD COLUMN `answer` TEXT NULL,
    ADD COLUMN `link` VARCHAR(500) NULL;

-- CreateTable
CREATE TABLE `WorkSimulationShare` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `WorkSimulationShare_runId_companyId_key`(`runId`, `companyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WorkSimulationShare` ADD CONSTRAINT `WorkSimulationShare_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `WorkSimulationRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkSimulationShare` ADD CONSTRAINT `WorkSimulationShare_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

