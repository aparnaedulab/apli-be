-- AlterTable
ALTER TABLE `Candidate` ADD COLUMN `dreamCompanies` JSON NULL,
    ADD COLUMN `heardFrom` VARCHAR(191) NULL,
    ADD COLUMN `preferredCities` JSON NULL,
    ADD COLUMN `signupStep` INTEGER NULL;

