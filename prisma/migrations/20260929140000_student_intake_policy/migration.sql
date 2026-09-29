-- What one institution collects about a student, and who may put them on the
-- roster.
--
-- Both answers were hard-coded for everybody before this: exactly three
-- required fields, and both the university and every college free to add
-- students at any time. Neither is true of every university.
--
-- One row per institution. A university whose roster means different things
-- at each of its colleges cannot report across them.
CREATE TABLE `StudentIntakePolicy` (
  `id`                VARCHAR(191) NOT NULL,
  `tenantId`          VARCHAR(191) NOT NULL,
  `fields`            JSON         NOT NULL,
  `universityMayAdd`  BOOLEAN      NOT NULL DEFAULT true,
  `collegeMayAdd`     BOOLEAN      NOT NULL DEFAULT true,
  `selfRegister`      BOOLEAN      NOT NULL DEFAULT false,
  `selfFields`        JSON         NOT NULL,
  `selfNeedsApproval` BOOLEAN      NOT NULL DEFAULT true,
  `updatedAt`         DATETIME(3)  NOT NULL,
  `createdAt`         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `StudentIntakePolicy_tenantId_key` (`tenantId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `StudentIntakePolicy`
  ADD CONSTRAINT `StudentIntakePolicy_tenantId_fkey`
  FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
