-- AlterTable
ALTER TABLE `Candidate` ADD COLUMN `collegeProgramId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `CollegeProgram` (
    `id` VARCHAR(191) NOT NULL,
    `collegeId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `specialisationId` VARCHAR(191) NULL,
    `intake` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CollegeProgram_collegeId_idx`(`collegeId`),
    INDEX `CollegeProgram_courseId_idx`(`courseId`),
    INDEX `CollegeProgram_specialisationId_idx`(`specialisationId`),
    UNIQUE INDEX `CollegeProgram_collegeId_courseId_specialisationId_key`(`collegeId`, `courseId`, `specialisationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Candidate_collegeProgramId_idx` ON `Candidate`(`collegeProgramId`);

-- AddForeignKey
ALTER TABLE `CollegeProgram` ADD CONSTRAINT `CollegeProgram_collegeId_fkey` FOREIGN KEY (`collegeId`) REFERENCES `College`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CollegeProgram` ADD CONSTRAINT `CollegeProgram_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `Course`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CollegeProgram` ADD CONSTRAINT `CollegeProgram_specialisationId_fkey` FOREIGN KEY (`specialisationId`) REFERENCES `Specialisation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Candidate` ADD CONSTRAINT `Candidate_collegeProgramId_fkey` FOREIGN KEY (`collegeProgramId`) REFERENCES `CollegeProgram`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

