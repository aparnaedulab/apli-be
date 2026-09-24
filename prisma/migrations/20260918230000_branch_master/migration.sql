-- Branches become one master list that courses pick from.
--
-- A branch used to be typed afresh under each course, so "Computer
-- Engineering" under B.Tech and "Computer Engg." under M.Tech were two
-- different things. Now each name exists once. Existing branches are folded
-- in: every distinct name (ignoring letter case) becomes one Branch, and each
-- course's branch points at it.

CREATE TABLE `Branch` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Branch_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One row per name. The collation is case-insensitive, so GROUP BY name
-- already treats "IT" and "it" as one; MIN picks a stable spelling.
INSERT INTO `Branch` (`id`, `name`)
SELECT CONCAT('br_', SUBSTRING(MD5(LOWER(MIN(`name`))), 1, 22)), MIN(`name`)
FROM `Specialisation`
GROUP BY `name`;

ALTER TABLE `Specialisation` ADD COLUMN `branchId` VARCHAR(191) NULL;
UPDATE `Specialisation` s JOIN `Branch` b ON b.`name` = s.`name` SET s.`branchId` = b.`id`, s.`name` = b.`name`;
ALTER TABLE `Specialisation` MODIFY `branchId` VARCHAR(191) NOT NULL;

CREATE INDEX `Specialisation_branchId_idx` ON `Specialisation`(`branchId`);
ALTER TABLE `Specialisation` ADD CONSTRAINT `Specialisation_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `Branch`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
