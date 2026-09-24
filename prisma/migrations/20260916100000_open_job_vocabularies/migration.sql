-- AlterTable
ALTER TABLE `Job` MODIFY `workMode` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Round` MODIFY `type` VARCHAR(191) NOT NULL DEFAULT 'RESUME_SCREEN',
    MODIFY `mode` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `JobOption` (
    `id` VARCHAR(191) NOT NULL,
    `kind` ENUM('WORK_MODE', 'ROUND_TYPE', 'ROUND_MODE') NOT NULL,
    `value` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `JobOption_kind_companyId_idx`(`kind`, `companyId`),
    UNIQUE INDEX `JobOption_kind_value_companyId_key`(`kind`, `value`, `companyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `JobOption` ADD CONSTRAINT `JobOption_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

