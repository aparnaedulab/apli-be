-- The directory of universities and colleges students pick from at sign-up.
CREATE TABLE `CollegeListing` (
    `id` VARCHAR(191) NOT NULL,
    `kind` ENUM('UNIVERSITY', 'COLLEGE') NOT NULL DEFAULT 'COLLEGE',
    `name` VARCHAR(191) NOT NULL,
    `city` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NULL,
    `affiliation` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CollegeListing_name_city_key`(`name`, `city`),
    INDEX `CollegeListing_isActive_name_idx`(`isActive`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- A student who picked a listed college that is not a partner.
ALTER TABLE `Candidate` ADD COLUMN `listingId` VARCHAR(191) NULL;
CREATE INDEX `Candidate_listingId_fkey` ON `Candidate`(`listingId`);
ALTER TABLE `Candidate` ADD CONSTRAINT `Candidate_listingId_fkey` FOREIGN KEY (`listingId`) REFERENCES `CollegeListing`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
