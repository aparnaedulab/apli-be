-- What a student tells us at sign-up, beyond name and college.
ALTER TABLE `Candidate` ADD COLUMN `degreeLevel` VARCHAR(191) NULL,
    ADD COLUMN `city` VARCHAR(191) NULL,
    ADD COLUMN `interests` JSON NULL;
