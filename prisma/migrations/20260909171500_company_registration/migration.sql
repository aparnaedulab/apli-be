-- Industries: admin-managed reference data, the same shape as CollegeType.
CREATE TABLE `Industry` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Industry_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Company profile, plus the review lifecycle.
ALTER TABLE `Company`
    ADD COLUMN `legalName` VARCHAR(191) NULL,
    ADD COLUMN `industryId` VARCHAR(191) NULL,
    ADD COLUMN `sizeBand` ENUM('STARTUP', 'SMALL', 'MID', 'LARGE', 'ENTERPRISE') NULL,
    ADD COLUMN `foundedYear` INTEGER NULL,
    ADD COLUMN `gstin` VARCHAR(191) NULL,
    ADD COLUMN `cin` VARCHAR(191) NULL,
    ADD COLUMN `careersUrl` VARCHAR(191) NULL,
    ADD COLUMN `linkedinUrl` VARCHAR(191) NULL,
    ADD COLUMN `city` VARCHAR(191) NULL,
    ADD COLUMN `state` VARCHAR(191) NULL,
    ADD COLUMN `address` TEXT NULL,
    ADD COLUMN `pincode` VARCHAR(191) NULL,
    ADD COLUMN `status` ENUM('PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED') NOT NULL DEFAULT 'PENDING',
    ADD COLUMN `appliedAt` DATETIME(3) NULL,
    ADD COLUMN `reviewedAt` DATETIME(3) NULL,
    ADD COLUMN `reviewedById` VARCHAR(191) NULL,
    ADD COLUMN `rejectionReason` TEXT NULL;

-- Carry the old boolean over BEFORE dropping it. A company that could publish
-- yesterday must still be able to publish today; defaulting them to PENDING
-- would silently pull every live posting.
UPDATE `Company` SET `status` = 'VERIFIED', `reviewedAt` = `updatedAt` WHERE `isVerified` = 1;

-- Companies that existed before this migration were entered by operations, so
-- appliedAt stays NULL: nobody applied for them.
ALTER TABLE `Company` DROP COLUMN `isVerified`;

CREATE INDEX `Company_status_idx` ON `Company`(`status`);
CREATE INDEX `Company_industryId_idx` ON `Company`(`industryId`);

ALTER TABLE `Company` ADD CONSTRAINT `Company_industryId_fkey` FOREIGN KEY (`industryId`) REFERENCES `Industry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `Company` ADD CONSTRAINT `Company_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
