
-- AlterTable
ALTER TABLE `MockInterviewSession` ADD COLUMN `questions` JSON NULL;

-- CreateTable
CREATE TABLE `InterviewQuestion` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL DEFAULT '',
    `text` VARCHAR(400) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `isVisible` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `InterviewQuestion_tenantId_kind_role_order_idx`(`tenantId`, `kind`, `role`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `InterviewQuestion` ADD CONSTRAINT `InterviewQuestion_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

