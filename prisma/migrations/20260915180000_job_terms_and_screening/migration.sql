-- AlterTable
ALTER TABLE `Application` ADD COLUMN `acceptedTermsAt` DATETIME(3) NULL,
    ADD COLUMN `screeningRef` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Job` ADD COLUMN `bondNote` TEXT NULL,
    ADD COLUMN `screeningTestDeadline` DATETIME(3) NULL,
    ADD COLUMN `screeningTestInstructions` TEXT NULL,
    ADD COLUMN `screeningTestName` VARCHAR(191) NULL,
    ADD COLUMN `screeningTestRequired` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `screeningTestUrl` TEXT NULL;

-- CreateTable
CREATE TABLE `JobTerm` (
    `id` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL,
    `text` TEXT NOT NULL,

    INDEX `JobTerm_jobId_idx`(`jobId`),
    UNIQUE INDEX `JobTerm_jobId_order_key`(`jobId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `JobTerm` ADD CONSTRAINT `JobTerm_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

