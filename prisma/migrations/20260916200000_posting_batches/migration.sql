-- CreateTable
CREATE TABLE `JobPostingBatch` (
    `postingId` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NOT NULL,

    INDEX `JobPostingBatch_batchId_idx`(`batchId`),
    PRIMARY KEY (`postingId`, `batchId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `JobPostingBatch` ADD CONSTRAINT `JobPostingBatch_postingId_fkey` FOREIGN KEY (`postingId`) REFERENCES `JobPosting`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JobPostingBatch` ADD CONSTRAINT `JobPostingBatch_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `Batch`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

