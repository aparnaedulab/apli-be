-- CreateTable
CREATE TABLE `CampusDrive` (
    `id` VARCHAR(191) NOT NULL,
    `collegeId` VARCHAR(191) NOT NULL,
    `placementId` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `status` ENUM('DRAFT', 'INVITED', 'ACCEPTED', 'SCHEDULED', 'OPEN', 'CLOSED', 'DECLINED') NOT NULL DEFAULT 'DRAFT',
    `title` VARCHAR(191) NOT NULL,
    `pitch` TEXT NULL,
    `scheduledAt` DATETIME(3) NULL,
    `addressLine` TEXT NULL,
    `meetingLink` TEXT NULL,
    `minCgpa` DECIMAL(4, 2) NULL,
    `minDegreePct` DECIMAL(5, 2) NULL,
    `maxBacklogs` INTEGER NULL,
    `maxActiveBacklogs` INTEGER NULL,
    `invitedAt` DATETIME(3) NULL,
    `respondedAt` DATETIME(3) NULL,
    `openedAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `declineReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CampusDrive_collegeId_status_idx`(`collegeId`, `status`),
    INDEX `CampusDrive_companyId_status_idx`(`companyId`, `status`),
    INDEX `CampusDrive_placementId_idx`(`placementId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CampusDriveCourse` (
    `driveId` VARCHAR(191) NOT NULL,
    `course` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`driveId`, `course`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CampusDriveBranch` (
    `driveId` VARCHAR(191) NOT NULL,
    `specialisation` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`driveId`, `specialisation`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CampusDriveGradYear` (
    `driveId` VARCHAR(191) NOT NULL,
    `year` INTEGER NOT NULL,

    PRIMARY KEY (`driveId`, `year`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CampusDriveJob` (
    `driveId` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `confirmedAt` DATETIME(3) NULL,

    INDEX `CampusDriveJob_jobId_idx`(`jobId`),
    PRIMARY KEY (`driveId`, `jobId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CampusDriveRegistration` (
    `id` VARCHAR(191) NOT NULL,
    `driveId` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `removedAt` DATETIME(3) NULL,

    INDEX `CampusDriveRegistration_candidateId_idx`(`candidateId`),
    UNIQUE INDEX `CampusDriveRegistration_driveId_candidateId_key`(`driveId`, `candidateId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CampusDrive` ADD CONSTRAINT `CampusDrive_collegeId_fkey` FOREIGN KEY (`collegeId`) REFERENCES `College`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampusDrive` ADD CONSTRAINT `CampusDrive_placementId_fkey` FOREIGN KEY (`placementId`) REFERENCES `Placement`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampusDrive` ADD CONSTRAINT `CampusDrive_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampusDriveCourse` ADD CONSTRAINT `CampusDriveCourse_driveId_fkey` FOREIGN KEY (`driveId`) REFERENCES `CampusDrive`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampusDriveBranch` ADD CONSTRAINT `CampusDriveBranch_driveId_fkey` FOREIGN KEY (`driveId`) REFERENCES `CampusDrive`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampusDriveGradYear` ADD CONSTRAINT `CampusDriveGradYear_driveId_fkey` FOREIGN KEY (`driveId`) REFERENCES `CampusDrive`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampusDriveJob` ADD CONSTRAINT `CampusDriveJob_driveId_fkey` FOREIGN KEY (`driveId`) REFERENCES `CampusDrive`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampusDriveJob` ADD CONSTRAINT `CampusDriveJob_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampusDriveRegistration` ADD CONSTRAINT `CampusDriveRegistration_driveId_fkey` FOREIGN KEY (`driveId`) REFERENCES `CampusDrive`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampusDriveRegistration` ADD CONSTRAINT `CampusDriveRegistration_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
