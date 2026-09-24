-- Details a placement cell already holds and should be entering at roster
-- time, rather than waiting for the student to self-report them.

ALTER TABLE `Candidate`
  ADD COLUMN `degreePct` DECIMAL(5,2)  NULL,
  ADD COLUMN `prn`       VARCHAR(191)  NULL;

-- Nullable unique: MySQL permits many NULLs, so this catches a duplicated
-- registration number without forcing every college to record one.
CREATE UNIQUE INDEX `Candidate_prn_key` ON `Candidate`(`prn`);

ALTER TABLE `BatchMembership` ADD COLUMN `division` VARCHAR(191) NULL;
