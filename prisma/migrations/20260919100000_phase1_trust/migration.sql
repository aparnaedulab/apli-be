-- Phase 1, the trust core: company page text, student job reports, DPDP
-- consent records, and how long a company has to respond.

ALTER TABLE `Company` ADD COLUMN `whyJoin` TEXT NULL, ADD COLUMN `howWeHire` TEXT NULL;

ALTER TABLE `Tenant` ADD COLUMN `responseDays` INTEGER NOT NULL DEFAULT 7;

CREATE TABLE `JobReport` (
    `id` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `collegeId` VARCHAR(191) NULL,
    `reason` ENUM('FEE_DEMANDED', 'FAKE_COMPANY', 'MISLEADING', 'OTHER') NOT NULL,
    `note` TEXT NULL,
    `status` ENUM('OPEN', 'REVIEWED', 'DISMISSED') NOT NULL DEFAULT 'OPEN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewedAt` DATETIME(3) NULL,
    `reviewedById` VARCHAR(191) NULL,

    UNIQUE INDEX `JobReport_jobId_candidateId_key`(`jobId`, `candidateId`),
    INDEX `JobReport_collegeId_status_idx`(`collegeId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ConsentRecord` (
    `id` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `purpose` VARCHAR(191) NOT NULL,
    `granted` BOOLEAN NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ConsentRecord_candidateId_purpose_createdAt_idx`(`candidateId`, `purpose`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `JobReport` ADD CONSTRAINT `JobReport_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `JobReport` ADD CONSTRAINT `JobReport_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ConsentRecord` ADD CONSTRAINT `ConsentRecord_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
