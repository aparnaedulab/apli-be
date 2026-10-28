-- Interview processes: a company's own interview rounds, the invites it
-- sends students, their recorded answers and the company's verdict per round.
-- The tables were added to the schema without a migration; this creates them.

-- CreateTable
CREATE TABLE `InterviewProcess` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `processType` VARCHAR(191) NOT NULL DEFAULT 'HIRING',
    `status` VARCHAR(191) NOT NULL DEFAULT 'DRAFT',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `InterviewProcess_companyId_idx`(`companyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InterviewProcessRound` (
    `id` VARCHAR(191) NOT NULL,
    `processId` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'RESUME_SCREEN',
    `isElimination` BOOLEAN NOT NULL DEFAULT false,
    `description` TEXT NULL,
    `isOnline` BOOLEAN NOT NULL DEFAULT false,
    `meetingLink` TEXT NULL,
    `addressLine` TEXT NULL,
    `shortlistCount` INTEGER NULL,
    `durationMin` INTEGER NULL,
    `mode` VARCHAR(191) NULL,
    `questionTimeSec` INTEGER NULL,
    `prepTimeSec` INTEGER NULL,
    `simulationId` VARCHAR(40) NULL,

    INDEX `InterviewProcessRound_processId_idx`(`processId`),
    UNIQUE INDEX `InterviewProcessRound_processId_order_key`(`processId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VideoInterviewQuestion` (
    `id` VARCHAR(191) NOT NULL,
    `roundId` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL,
    `text` VARCHAR(600) NOT NULL,
    `hint` VARCHAR(400) NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'behavioural',

    INDEX `VideoInterviewQuestion_roundId_idx`(`roundId`),
    UNIQUE INDEX `VideoInterviewQuestion_roundId_order_key`(`roundId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InterviewQuestionPackage` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `role` VARCHAR(191) NOT NULL DEFAULT '',
    `kind` VARCHAR(191) NOT NULL DEFAULT 'VIDEO_INTERVIEW',
    `questions` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InterviewInvite` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `processId` VARCHAR(191) NOT NULL,
    `sentById` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `message` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `currentRoundOrder` INTEGER NOT NULL DEFAULT 1,
    `respondedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `InterviewInvite_companyId_idx`(`companyId`),
    INDEX `InterviewInvite_candidateId_idx`(`candidateId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InterviewVideoAnswer` (
    `id` VARCHAR(191) NOT NULL,
    `inviteId` VARCHAR(191) NOT NULL,
    `questionId` VARCHAR(191) NOT NULL,
    `fileUrl` VARCHAR(500) NOT NULL,
    `seconds` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `InterviewVideoAnswer_questionId_idx`(`questionId`),
    UNIQUE INDEX `InterviewVideoAnswer_inviteId_questionId_key`(`inviteId`, `questionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InterviewRoundFeedback` (
    `id` VARCHAR(191) NOT NULL,
    `inviteId` VARCHAR(191) NOT NULL,
    `roundOrder` INTEGER NOT NULL,
    `roundName` VARCHAR(191) NOT NULL,
    `outcome` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `score` DECIMAL(5, 2) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `InterviewRoundFeedback_inviteId_idx`(`inviteId`),
    UNIQUE INDEX `InterviewRoundFeedback_inviteId_roundOrder_key`(`inviteId`, `roundOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `InterviewProcess` ADD CONSTRAINT `InterviewProcess_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InterviewProcess` ADD CONSTRAINT `InterviewProcess_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InterviewProcessRound` ADD CONSTRAINT `InterviewProcessRound_processId_fkey` FOREIGN KEY (`processId`) REFERENCES `InterviewProcess`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VideoInterviewQuestion` ADD CONSTRAINT `VideoInterviewQuestion_roundId_fkey` FOREIGN KEY (`roundId`) REFERENCES `InterviewProcessRound`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InterviewInvite` ADD CONSTRAINT `InterviewInvite_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InterviewInvite` ADD CONSTRAINT `InterviewInvite_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InterviewInvite` ADD CONSTRAINT `InterviewInvite_processId_fkey` FOREIGN KEY (`processId`) REFERENCES `InterviewProcess`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InterviewInvite` ADD CONSTRAINT `InterviewInvite_sentById_fkey` FOREIGN KEY (`sentById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InterviewVideoAnswer` ADD CONSTRAINT `InterviewVideoAnswer_inviteId_fkey` FOREIGN KEY (`inviteId`) REFERENCES `InterviewInvite`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InterviewVideoAnswer` ADD CONSTRAINT `InterviewVideoAnswer_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `VideoInterviewQuestion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InterviewRoundFeedback` ADD CONSTRAINT `InterviewRoundFeedback_inviteId_fkey` FOREIGN KEY (`inviteId`) REFERENCES `InterviewInvite`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
