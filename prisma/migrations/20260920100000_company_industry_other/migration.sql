-- A company whose industry is not on the shared list types it instead, and
-- operations resolves it during verification. Without this the company had
-- no way through registration at all.
ALTER TABLE `Company` ADD COLUMN `industryOther` VARCHAR(191) NULL;
