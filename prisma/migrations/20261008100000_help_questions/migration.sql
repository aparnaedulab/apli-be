-- CreateTable
CREATE TABLE `HelpQuestion` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `question` VARCHAR(300) NOT NULL,
    `answer` TEXT NOT NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `isVisible` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `HelpQuestion_tenantId_order_idx`(`tenantId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `HelpQuestion` ADD CONSTRAINT `HelpQuestion_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

