-- AlterTable
ALTER TABLE `Candidate` ADD COLUMN `pgCgpa` DECIMAL(4, 2) NULL,
    ADD COLUMN `pgPct` DECIMAL(5, 2) NULL;

-- AlterTable
ALTER TABLE `Job` ADD COLUMN `minPgCgpa` DECIMAL(4, 2) NULL,
    ADD COLUMN `minPgPct` DECIMAL(5, 2) NULL;

