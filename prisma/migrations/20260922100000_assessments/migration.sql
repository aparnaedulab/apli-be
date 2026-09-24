-- Assessments: a test somebody is asked to sit.
--
-- Assigned, never requested. A company shortlists and says "take this by
-- Friday"; an approval step between the two would be latency nobody benefits
-- from. Apli does not host the questions yet, so `url` points at the
-- company's own platform - what is held here is who was asked, by when, and
-- what came back, which is the part that was missing entirely.
--
-- utf8mb4_unicode_ci throughout, to match every other table in this schema.

CREATE TABLE `Assessment` (
  `id`           VARCHAR(191) NOT NULL,
  `companyId`    VARCHAR(191) NULL,
  `collegeId`    VARCHAR(191) NULL,
  `title`        VARCHAR(191) NOT NULL,
  `instructions` TEXT NULL,
  `url`          TEXT NULL,
  `durationMin`  INT NULL,
  `supervised`   BOOLEAN NOT NULL DEFAULT false,
  `retakes`      INT NOT NULL DEFAULT 0,
  `createdById`  VARCHAR(191) NOT NULL,
  `createdAt`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`    DATETIME(3) NOT NULL,

  INDEX `Assessment_companyId_idx` (`companyId`),
  INDEX `Assessment_collegeId_idx` (`collegeId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AssessmentAssignment` (
  `id`            VARCHAR(191) NOT NULL,
  `assessmentId`  VARCHAR(191) NOT NULL,
  `candidateId`   VARCHAR(191) NOT NULL,
  `applicationId` VARCHAR(191) NULL,
  `dueAt`         DATETIME(3) NULL,
  `status`        ENUM('ASSIGNED','SUBMITTED','PASSED','FAILED','MISSED')
                  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
                  NOT NULL DEFAULT 'ASSIGNED',
  `attempt`       INT NOT NULL DEFAULT 1,
  `submittedRef`  VARCHAR(191) NULL,
  `submittedAt`   DATETIME(3) NULL,
  `score`         DECIMAL(6,2) NULL,
  `maxScore`      DECIMAL(6,2) NULL,
  `feedback`      TEXT NULL,
  `reviewedById`  VARCHAR(191) NULL,
  `reviewedAt`    DATETIME(3) NULL,
  `createdAt`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`     DATETIME(3) NOT NULL,

  -- One student sits one test once per attempt.
  UNIQUE INDEX `AssessmentAssignment_assessmentId_candidateId_attempt_key`
    (`assessmentId`, `candidateId`, `attempt`),
  INDEX `AssessmentAssignment_candidateId_status_idx` (`candidateId`, `status`),
  INDEX `AssessmentAssignment_applicationId_idx` (`applicationId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Assessment`
  ADD CONSTRAINT `Assessment_companyId_fkey` FOREIGN KEY (`companyId`)
    REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `Assessment_collegeId_fkey` FOREIGN KEY (`collegeId`)
    REFERENCES `College`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `Assessment_createdById_fkey` FOREIGN KEY (`createdById`)
    REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `AssessmentAssignment`
  ADD CONSTRAINT `AssessmentAssignment_assessmentId_fkey` FOREIGN KEY (`assessmentId`)
    REFERENCES `Assessment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AssessmentAssignment_candidateId_fkey` FOREIGN KEY (`candidateId`)
    REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `AssessmentAssignment_applicationId_fkey` FOREIGN KEY (`applicationId`)
    REFERENCES `Application`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `AssessmentAssignment_reviewedById_fkey` FOREIGN KEY (`reviewedById`)
    REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
