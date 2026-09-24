-- CreateTable
CREATE TABLE `RefValue` (
    `id` VARCHAR(191) NOT NULL,
    `kind` ENUM('CITY', 'STATE', 'NAAC_GRADE', 'GENDER') NOT NULL,
    `value` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RefValue_kind_isActive_idx`(`kind`, `isActive`),
    UNIQUE INDEX `RefValue_kind_value_key`(`kind`, `value`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

