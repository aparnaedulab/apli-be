-- College type becomes managed data instead of a free-text column, so the
-- values stay consistent and operations can add new ones without a deploy.

CREATE TABLE `CollegeType` (
  `id`        VARCHAR(191) NOT NULL,
  `name`      VARCHAR(191) NOT NULL,
  `isActive`  BOOLEAN      NOT NULL DEFAULT true,
  `createdAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `CollegeType_name_key`(`name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `CollegeType` (`id`, `name`) VALUES
  ('ctype_engineering',  'Engineering'),
  ('ctype_management',   'Management'),
  ('ctype_pharmacy',     'Pharmacy'),
  ('ctype_architecture', 'Architecture'),
  ('ctype_science',      'Science'),
  ('ctype_commerce',     'Commerce'),
  ('ctype_law',          'Law'),
  ('ctype_medical',      'Medical');

ALTER TABLE `College` ADD COLUMN `collegeTypeId` VARCHAR(191) NULL;

-- Carry existing values across by name; anything unrecognised simply becomes
-- null rather than being guessed at.
UPDATE `College` c
  JOIN `CollegeType` t ON t.`name` = c.`type`
  SET c.`collegeTypeId` = t.`id`;

ALTER TABLE `College` DROP COLUMN `type`;

CREATE INDEX `College_collegeTypeId_idx` ON `College`(`collegeTypeId`);

-- Restrict, not cascade: retiring a type must never quietly delete colleges.
ALTER TABLE `College` ADD CONSTRAINT `College_collegeTypeId_fkey`
  FOREIGN KEY (`collegeTypeId`) REFERENCES `CollegeType`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
