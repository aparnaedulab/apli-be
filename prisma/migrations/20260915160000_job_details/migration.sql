-- DropForeignKey
ALTER TABLE `College` DROP FOREIGN KEY `College_collegeTypeId_fkey`;

-- AlterTable
ALTER TABLE `Candidate` ADD COLUMN `activeBacklogs` INTEGER NULL,
    ADD COLUMN `gapYears` INTEGER NULL,
    ADD COLUMN `isLateralEntry` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Job` DROP COLUMN `noticePeriod`,
    ADD COLUMN `allowsLateralEntry` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `bondAmount` DECIMAL(12, 2) NULL,
    ADD COLUMN `ctcFixed` DECIMAL(12, 2) NULL,
    ADD COLUMN `ctcVariable` DECIMAL(12, 2) NULL,
    ADD COLUMN `internshipMonths` INTEGER NULL,
    ADD COLUMN `joiningBonus` DECIMAL(12, 2) NULL,
    ADD COLUMN `joiningFrom` DATETIME(3) NULL,
    ADD COLUMN `maxActiveBacklogs` INTEGER NULL,
    ADD COLUMN `maxGapYears` INTEGER NULL,
    ADD COLUMN `openings` INTEGER NULL,
    ADD COLUMN `ppoCtc` DECIMAL(12, 2) NULL,
    ADD COLUMN `stipendPerMonth` DECIMAL(10, 2) NULL,
    ADD COLUMN `workMode` ENUM('ONSITE', 'HYBRID', 'REMOTE') NULL,
    MODIFY `jobType` ENUM('FULL_TIME', 'INTERNSHIP', 'INTERNSHIP_PPO', 'CONTRACT') NOT NULL DEFAULT 'FULL_TIME';

-- AlterTable
ALTER TABLE `Round` ADD COLUMN `durationMin` INTEGER NULL,
    ADD COLUMN `mode` ENUM('ON_CAMPUS', 'ONLINE', 'AT_OFFICE') NULL,
    ADD COLUMN `scheduledAt` DATETIME(3) NULL,
    ADD COLUMN `venue` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `JobSpecialisation` (
    `jobId` VARCHAR(191) NOT NULL,
    `specialisation` VARCHAR(191) NOT NULL,

    INDEX `JobSpecialisation_specialisation_idx`(`specialisation`),
    PRIMARY KEY (`jobId`, `specialisation`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JobSkill` (
    `jobId` VARCHAR(191) NOT NULL,
    `skillId` VARCHAR(191) NOT NULL,

    INDEX `JobSkill_skillId_idx`(`skillId`),
    PRIMARY KEY (`jobId`, `skillId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JobTeamMember` (
    `jobId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `addedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `JobTeamMember_userId_idx`(`userId`),
    PRIMARY KEY (`jobId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `College` ADD CONSTRAINT `College_collegeTypeId_fkey` FOREIGN KEY (`collegeTypeId`) REFERENCES `CollegeType`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JobSpecialisation` ADD CONSTRAINT `JobSpecialisation_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JobSkill` ADD CONSTRAINT `JobSkill_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JobSkill` ADD CONSTRAINT `JobSkill_skillId_fkey` FOREIGN KEY (`skillId`) REFERENCES `Skill`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JobTeamMember` ADD CONSTRAINT `JobTeamMember_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JobTeamMember` ADD CONSTRAINT `JobTeamMember_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

