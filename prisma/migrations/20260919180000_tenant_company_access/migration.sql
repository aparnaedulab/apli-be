-- An institution may require its own approval of a company before that
-- company reaches any of its colleges. Off by default: the platform's
-- verification plus each college's per-posting approval stay the gate.
ALTER TABLE `Tenant` ADD COLUMN `companyApprovalRequired` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `TenantCompany` (
    `tenantId` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `note` TEXT NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decidedAt` DATETIME(3) NULL,
    `decidedById` VARCHAR(191) NULL,

    INDEX `TenantCompany_companyId_idx`(`companyId`),
    PRIMARY KEY (`tenantId`, `companyId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TenantCompany` ADD CONSTRAINT `TenantCompany_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
