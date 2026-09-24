-- Tenants.
--
-- The portal stops being one university's and becomes a platform many
-- institutions buy. A tenant owns colleges; everything a campus holds reaches a
-- tenant through its college, and a university-wide batch - which has no
-- college - carries its tenant directly.
--
-- Nothing already here loses its home on the way. If this database holds any
-- colleges or batches, they are gathered into one "home" tenant that is
-- already live, so the portal behaves exactly as before until somebody
-- onboards a second institution. A fresh database gets no tenant at all.

CREATE TABLE `Tenant` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `shortName` VARCHAR(191) NULL,
    `slug` VARCHAR(191) NOT NULL,
    `kind` ENUM('UNIVERSITY', 'COLLEGE', 'GROUP') NOT NULL DEFAULT 'UNIVERSITY',
    `status` ENUM('DRAFT', 'ACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'DRAFT',
    `legalName` VARCHAR(191) NULL,
    `website` VARCHAR(191) NULL,
    `logoUrl` TEXT NULL,
    `brandColor` VARCHAR(191) NOT NULL DEFAULT '#1d3b8b',
    `tagline` VARCHAR(191) NULL,
    `city` VARCHAR(191) NULL,
    `state` VARCHAR(191) NULL,
    `address` TEXT NULL,
    `pincode` VARCHAR(191) NULL,
    `contactName` VARCHAR(191) NULL,
    `contactEmail` VARCHAR(191) NULL,
    `contactPhone` VARCHAR(191) NULL,
    `gradingScale` ENUM('CGPA_10', 'CGPA_4', 'PERCENTAGE', 'BOTH') NOT NULL DEFAULT 'CGPA_10',
    `academicYearStartMonth` INTEGER NOT NULL DEFAULT 6,
    `oneOfferDefault` BOOLEAN NOT NULL DEFAULT true,
    `allowSelfJoin` BOOLEAN NOT NULL DEFAULT true,
    `plan` VARCHAR(191) NOT NULL DEFAULT 'STARTER',
    `completedSteps` JSON NOT NULL,
    `launchedAt` DATETIME(3) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Tenant_slug_key`(`slug`),
    INDEX `Tenant_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TenantModule` (
    `tenantId` VARCHAR(191) NOT NULL,
    `moduleKey` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`tenantId`, `moduleKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TenantProgram` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `specialisationId` VARCHAR(191) NULL,

    INDEX `TenantProgram_tenantId_idx`(`tenantId`),
    UNIQUE INDEX `TenantProgram_tenantId_courseId_specialisationId_key`(`tenantId`, `courseId`, `specialisationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The home tenant, only where there is something to put in it. Live from the
-- start, with every module that already exists switched on, because that is
-- what this portal was doing yesterday.
INSERT INTO `Tenant` (`id`, `name`, `slug`, `kind`, `status`, `plan`, `completedSteps`, `launchedAt`, `updatedAt`)
SELECT 'tenant_home', 'Home university', 'home', 'UNIVERSITY', 'ACTIVE', 'CUSTOM',
       JSON_ARRAY('identity', 'academics', 'colleges', 'features', 'people', 'review'), NOW(3), NOW(3)
FROM DUAL
WHERE EXISTS (SELECT 1 FROM `College`) OR EXISTS (SELECT 1 FROM `Batch`);

INSERT INTO `TenantModule` (`tenantId`, `moduleKey`, `enabled`, `updatedAt`)
SELECT 'tenant_home', m.k, true, NOW(3)
FROM (
    SELECT 'core.roster' AS k UNION ALL SELECT 'core.drives' UNION ALL SELECT 'core.jobs'
    UNION ALL SELECT 'core.pipeline' UNION ALL SELECT 'core.notifications'
    UNION ALL SELECT 'core.dashboards'
) m
WHERE EXISTS (SELECT 1 FROM `Tenant` WHERE `id` = 'tenant_home');

-- College and Batch: add nullable, fill, then tighten. Adding NOT NULL
-- straight away would fail on any row that already exists.
ALTER TABLE `College` ADD COLUMN `tenantId` VARCHAR(191) NULL;
UPDATE `College` SET `tenantId` = 'tenant_home';
ALTER TABLE `College` MODIFY `tenantId` VARCHAR(191) NOT NULL;

ALTER TABLE `Batch` ADD COLUMN `tenantId` VARCHAR(191) NULL;
UPDATE `Batch` SET `tenantId` = 'tenant_home';
ALTER TABLE `Batch` MODIFY `tenantId` VARCHAR(191) NOT NULL;

-- Operations accounts. The super admin becomes the platform team (no tenant);
-- everybody else in operations was running the one university there was, so
-- they stay with it.
ALTER TABLE `AdminMember` ADD COLUMN `tenantId` VARCHAR(191) NULL;
UPDATE `AdminMember` am
JOIN `PlatformRole` r ON r.`id` = am.`roleId`
SET am.`tenantId` = 'tenant_home'
WHERE (r.`key` IS NULL OR r.`key` <> 'admin.super')
  AND EXISTS (SELECT 1 FROM `Tenant` WHERE `id` = 'tenant_home');

ALTER TABLE `Invite` ADD COLUMN `tenantId` VARCHAR(191) NULL;

CREATE INDEX `AdminMember_tenantId_idx` ON `AdminMember`(`tenantId`);
CREATE INDEX `Batch_tenantId_idx` ON `Batch`(`tenantId`);
CREATE INDEX `College_tenantId_idx` ON `College`(`tenantId`);

ALTER TABLE `TenantModule` ADD CONSTRAINT `TenantModule_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TenantProgram` ADD CONSTRAINT `TenantProgram_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TenantProgram` ADD CONSTRAINT `TenantProgram_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TenantProgram` ADD CONSTRAINT `TenantProgram_specialisationId_fkey` FOREIGN KEY (`specialisationId`) REFERENCES `Specialisation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `College` ADD CONSTRAINT `College_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AdminMember` ADD CONSTRAINT `AdminMember_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `Batch` ADD CONSTRAINT `Batch_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Invite` ADD CONSTRAINT `Invite_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
