-- A student applying for two different kinds of role writes two different
-- resumes. One `resumeUrl` column meant the second overwrote the first, and
-- left the first on disk with nothing pointing at it.
CREATE TABLE `Resume` (
    `id` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `url` VARCHAR(191) NOT NULL,
    `source` ENUM('BUILT', 'UPLOADED') NOT NULL,
    `build` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Resume_candidateId_idx`(`candidateId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Resume` ADD CONSTRAINT `Resume_candidateId_fkey`
    FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Whatever each student is already using becomes their first saved resume, so
-- nobody opens the new list and finds it empty while their profile still
-- carries a resume. Only ones we stored: an https link somebody hosts
-- themselves is not a file this list manages.
INSERT INTO `Resume` (`id`, `candidateId`, `name`, `url`, `source`, `build`, `createdAt`)
SELECT
    CONCAT('res_', REPLACE(UUID(), '-', '')),
    `id`,
    CASE WHEN `resumeBuild` IS NULL THEN 'Uploaded resume' ELSE 'Built here' END,
    `resumeUrl`,
    CASE WHEN `resumeBuild` IS NULL THEN 'UPLOADED' ELSE 'BUILT' END,
    `resumeBuild`,
    NOW(3)
FROM `Candidate`
WHERE `resumeUrl` LIKE '/api/files/resume-%';
