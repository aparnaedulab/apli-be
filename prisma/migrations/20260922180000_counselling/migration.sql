-- Career counselling.
--
-- The portal already knows when a student has stalled - atRisk computes it
-- and tells the college. What it has never had is the other direction: a way
-- for the student to say they need a conversation. This is that, fenced at
-- the college like everything else.
--
-- utf8mb4_unicode_ci throughout, to match every other table in this schema.

CREATE TABLE `CounsellingRequest` (
  `id`           VARCHAR(191) NOT NULL,
  `candidateId`  VARCHAR(191) NOT NULL,
  `collegeId`    VARCHAR(191) NOT NULL,
  `reason`       ENUM('OFFER_CHOICE','NOT_SHORTLISTED','BOND_OR_LOCATION','FAMILY','DIRECTION','OTHER')
                 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `note`         TEXT NULL,
  `status`       ENUM('OPEN','BOOKED','DONE','CLOSED')
                 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
                 NOT NULL DEFAULT 'OPEN',
  `meetAt`       DATETIME(3) NULL,
  `meetWhere`    VARCHAR(191) NULL,
  `counsellorId` VARCHAR(191) NULL,
  -- Written for the student to read, not as a note about them.
  `outcome`      TEXT NULL,
  `createdAt`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`    DATETIME(3) NOT NULL,

  INDEX `CounsellingRequest_collegeId_status_createdAt_idx` (`collegeId`, `status`, `createdAt`),
  INDEX `CounsellingRequest_candidateId_createdAt_idx` (`candidateId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CounsellingRequest`
  ADD CONSTRAINT `CounsellingRequest_candidateId_fkey` FOREIGN KEY (`candidateId`)
    REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `CounsellingRequest_collegeId_fkey` FOREIGN KEY (`collegeId`)
    REFERENCES `College`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `CounsellingRequest_counsellorId_fkey` FOREIGN KEY (`counsellorId`)
    REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
