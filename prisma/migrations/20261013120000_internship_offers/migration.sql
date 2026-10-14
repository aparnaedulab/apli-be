-- CreateTable
CREATE TABLE `InternshipOffer` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NULL,
    `sentById` VARCHAR(191) NOT NULL,
    `role` VARCHAR(120) NOT NULL,
    `about` TEXT NOT NULL,
    `workMode` VARCHAR(10) NOT NULL,
    `city` VARCHAR(80) NULL,
    `months` INTEGER NOT NULL,
    `startsOn` DATE NULL,
    `stipend` INTEGER NULL,
    `respondBy` DATE NOT NULL,
    `noFeeAt` DATETIME(3) NOT NULL,
    `status` ENUM('SENT', 'ACCEPTED', 'DECLINED', 'WITHDRAWN') NOT NULL DEFAULT 'SENT',
    `respondedAt` DATETIME(3) NULL,
    `studentNote` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `InternshipOffer_candidateId_status_idx`(`candidateId`, `status`),
    INDEX `InternshipOffer_companyId_status_idx`(`companyId`, `status`),
    INDEX `InternshipOffer_runId_idx`(`runId`),
    INDEX `InternshipOffer_sentById_idx`(`sentById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `InternshipOffer` ADD CONSTRAINT `InternshipOffer_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InternshipOffer` ADD CONSTRAINT `InternshipOffer_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InternshipOffer` ADD CONSTRAINT `InternshipOffer_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `WorkSimulationRun`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InternshipOffer` ADD CONSTRAINT `InternshipOffer_sentById_fkey` FOREIGN KEY (`sentById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
