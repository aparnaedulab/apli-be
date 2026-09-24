-- Roles become rows.
--
-- They were two enums that only ever gated "can you manage the team". Making
-- them data lets a university decide for itself who may verify a student or
-- publish a role, and gives operations a screen to say so.
--
-- Nobody loses their reach on the way: every existing member is matched to the
-- seeded role that means what their enum meant, and the enum columns only go
-- once that has happened.

CREATE TABLE `PlatformRole` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `scope` ENUM('CAMPUS', 'COMPANY', 'ADMIN') NOT NULL,
    `permissions` JSON NOT NULL,
    `isSystem` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PlatformRole_key_key`(`key`),
    UNIQUE INDEX `PlatformRole_scope_name_key`(`scope`, `name`),
    INDEX `PlatformRole_scope_idx`(`scope`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AdminMember` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `roleId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AdminMember_userId_key`(`userId`),
    INDEX `AdminMember_roleId_idx`(`roleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The roles every deployment starts with. Kept in step with SYSTEM_ROLES in
-- permissions.ts; the seed upserts the same set, so a fresh database and a
-- migrated one end up identical.
INSERT INTO `PlatformRole` (`id`, `key`, `name`, `description`, `scope`, `permissions`, `isSystem`, `updatedAt`) VALUES
('role_campus_officer', 'campus.officer', 'Placement officer', 'Runs the placement cell. Can do everything for their college, including verifying students and managing the team.', 'CAMPUS',
 '["roster:read","roster:write","roster:verify","drive:write","posting:decide","application:read","application:advance","team:manage"]', true, NOW(3)),
('role_campus_coord', 'campus.coordinator', 'Coordinator', 'Day-to-day placement work: rosters, drives and applications. Cannot verify students or change the team.', 'CAMPUS',
 '["roster:read","roster:write","drive:write","posting:decide","application:read","application:advance"]', true, NOW(3)),
('role_campus_viewer', 'campus.viewer', 'Viewer', 'Reads the roster and applications. Changes nothing. For a head of department or principal.', 'CAMPUS',
 '["roster:read","application:read"]', true, NOW(3)),
('role_company_owner', 'company.owner', 'Owner', 'Runs the company account. Publishes roles, decides offers, manages the team.', 'COMPANY',
 '["job:write","job:publish","posting:target","application:read","application:advance","offer:decide","team:manage"]', true, NOW(3)),
('role_company_recruit', 'company.recruiter', 'Recruiter', 'Drafts roles and works the pipeline. Cannot publish a role or change the team.', 'COMPANY',
 '["job:write","posting:target","application:read","application:advance"]', true, NOW(3)),
('role_company_intervw', 'company.interviewer', 'Interviewer', 'Sees applicants and records round outcomes. Cannot draft or publish roles.', 'COMPANY',
 '["application:read","application:advance"]', true, NOW(3)),
('role_admin_super', 'admin.super', 'Super admin', 'Everything, including creating roles and other admins.', 'ADMIN',
 '["college:write","company:verify","settings:write","user:manage","role:manage","audit:read","roster:read","roster:write","application:read"]', true, NOW(3)),
('role_admin_ops', 'admin.operations', 'Operations', 'Onboards colleges and verifies companies. Cannot change settings, roles or accounts.', 'ADMIN',
 '["college:write","company:verify","audit:read","roster:read","roster:write","application:read"]', true, NOW(3));

-- Every existing ADMIN account becomes a super admin: that is what it was.
INSERT INTO `AdminMember` (`id`, `userId`, `roleId`)
SELECT CONCAT('am_', `id`), `id`, 'role_admin_super' FROM `User` WHERE `role` = 'ADMIN';

-- Carry the memberships across BEFORE the enum columns go.
ALTER TABLE `CampusMember` ADD COLUMN `roleId` VARCHAR(191) NULL;
UPDATE `CampusMember` SET `roleId` =
    CASE `role` WHEN 'TPO' THEN 'role_campus_officer' ELSE 'role_campus_coord' END;
ALTER TABLE `CampusMember` MODIFY `roleId` VARCHAR(191) NOT NULL;
ALTER TABLE `CampusMember` DROP COLUMN `role`;

ALTER TABLE `CompanyMember` ADD COLUMN `roleId` VARCHAR(191) NULL;
UPDATE `CompanyMember` SET `roleId` = CASE `role`
    WHEN 'OWNER' THEN 'role_company_owner'
    WHEN 'INTERVIEWER' THEN 'role_company_intervw'
    ELSE 'role_company_recruit' END;
ALTER TABLE `CompanyMember` MODIFY `roleId` VARCHAR(191) NOT NULL;
ALTER TABLE `CompanyMember` DROP COLUMN `role`;

-- An invitation grants a role. The old enums stay on Invite for now: a
-- half-accepted invitation should still mean what it meant when it was sent.
ALTER TABLE `Invite` ADD COLUMN `roleId` VARCHAR(191) NULL;
UPDATE `Invite` SET `roleId` =
    CASE WHEN `campusRole` = 'TPO' THEN 'role_campus_officer'
         WHEN `campusRole` = 'COORDINATOR' THEN 'role_campus_coord'
         WHEN `companyRole` = 'OWNER' THEN 'role_company_owner'
         WHEN `companyRole` = 'INTERVIEWER' THEN 'role_company_intervw'
         WHEN `companyRole` = 'RECRUITER' THEN 'role_company_recruit'
         ELSE NULL END;

CREATE INDEX `CampusMember_roleId_idx` ON `CampusMember`(`roleId`);
CREATE INDEX `CompanyMember_roleId_idx` ON `CompanyMember`(`roleId`);
CREATE INDEX `Invite_roleId_idx` ON `Invite`(`roleId`);

ALTER TABLE `AdminMember` ADD CONSTRAINT `AdminMember_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `AdminMember` ADD CONSTRAINT `AdminMember_roleId_fkey`
    FOREIGN KEY (`roleId`) REFERENCES `PlatformRole`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `CampusMember` ADD CONSTRAINT `CampusMember_roleId_fkey`
    FOREIGN KEY (`roleId`) REFERENCES `PlatformRole`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `CompanyMember` ADD CONSTRAINT `CompanyMember_roleId_fkey`
    FOREIGN KEY (`roleId`) REFERENCES `PlatformRole`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Invite` ADD CONSTRAINT `Invite_roleId_fkey`
    FOREIGN KEY (`roleId`) REFERENCES `PlatformRole`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
