-- AlterTable
ALTER TABLE `Candidate` ADD COLUMN `diplomaPct` DECIMAL(5, 2) NULL;

-- AlterTable
ALTER TABLE `Job` ADD COLUMN `minDegreePct` DECIMAL(5, 2) NULL,
    ADD COLUMN `minDiplomaPct` DECIMAL(5, 2) NULL,
    ADD COLUMN `preferredCgpa` DECIMAL(4, 2) NULL,
    ADD COLUMN `preferredDegreePct` DECIMAL(5, 2) NULL;

-- AlterTable
ALTER TABLE `JobSkill` ADD COLUMN `isRequired` BOOLEAN NOT NULL DEFAULT false;

