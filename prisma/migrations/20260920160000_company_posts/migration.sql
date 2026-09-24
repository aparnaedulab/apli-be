-- A company page that never changes reads as abandoned, so a company can post
-- updates on it: a hire, a product, a campus visit. Read by students and
-- placement cells; written only by the company.

ALTER TABLE `Company` ADD COLUMN `headline` VARCHAR(191) NULL;

CREATE TABLE `CompanyPost` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `authorId` VARCHAR(191) NULL,
    `title` VARCHAR(191) NULL,
    -- Sanitised before it is stored: what is here is what a browser renders.
    `bodyHtml` TEXT NOT NULL,
    `media` JSON NOT NULL,
    -- Null means a draft, and is why this is nullable rather than defaulted.
    `publishedAt` DATETIME(3) NULL,
    `pinned` BOOLEAN NOT NULL DEFAULT false,
    -- Soft delete: a page open in a student's browser should not break under
    -- them, and a company can be asked what it posted.
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CompanyPost_companyId_publishedAt_idx`(`companyId`, `publishedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CompanyPost` ADD CONSTRAINT `CompanyPost_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CompanyPost` ADD CONSTRAINT `CompanyPost_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
