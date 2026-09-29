-- A spelling one college uses for a programme it runs.
--
-- Rosters are typed by departments, over years, by people who each have their
-- own shorthand: "BCom Prog", "B.Com (CS)" and "BCPM" turn up in three files
-- for one programme. Teaching the spelling once, from the upload preview, is
-- what makes a strict programme check survivable for a placement cell.
--
-- Unique per college, not per programme: one word must not mean two different
-- degrees at the same place.
CREATE TABLE `ProgramAlias` (
  `id`               VARCHAR(191) NOT NULL,
  `collegeId`        VARCHAR(191) NOT NULL,
  `collegeProgramId` VARCHAR(191) NOT NULL,
  `alias`            VARCHAR(191) NOT NULL,
  `createdAt`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdById`      VARCHAR(191) NULL,

  UNIQUE INDEX `ProgramAlias_collegeId_alias_key` (`collegeId`, `alias`),
  INDEX `ProgramAlias_collegeProgramId_idx` (`collegeProgramId`),
  INDEX `ProgramAlias_createdById_idx` (`createdById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ProgramAlias`
  ADD CONSTRAINT `ProgramAlias_collegeId_fkey`
  FOREIGN KEY (`collegeId`) REFERENCES `College`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ProgramAlias`
  ADD CONSTRAINT `ProgramAlias_collegeProgramId_fkey`
  FOREIGN KEY (`collegeProgramId`) REFERENCES `CollegeProgram`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ProgramAlias`
  ADD CONSTRAINT `ProgramAlias_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
