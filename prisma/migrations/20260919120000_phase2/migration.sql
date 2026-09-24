-- Phase 2: internships, readiness and aptitude practice, mock interviews,
-- work simulations, campus stories, the student showcase, the employer CRM
-- and drive day. New tables only - nothing that exists changes shape.

-- CreateTable
CREATE TABLE `Internship` (
    `id` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `collegeId` VARCHAR(191) NULL,
    `tenantId` VARCHAR(191) NULL,
    `companyId` VARCHAR(191) NULL,
    `jobId` VARCHAR(191) NULL,
    `organisation` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `mode` VARCHAR(191) NULL,
    `startDate` DATETIME(3) NOT NULL,
    `endDate` DATETIME(3) NOT NULL,
    `hoursPerWeek` INTEGER NULL,
    `credits` DECIMAL(4, 1) NULL,
    `status` ENUM('PROPOSED', 'APPROVED', 'ONGOING', 'COMPLETED', 'REJECTED', 'WITHDRAWN') NOT NULL DEFAULT 'PROPOSED',
    `decisionNote` TEXT NULL,
    `mentorName` VARCHAR(191) NULL,
    `mentorEmail` VARCHAR(191) NULL,
    `mentorTokenHash` VARCHAR(191) NULL,
    `evaluationScore` INTEGER NULL,
    `evaluationNote` TEXT NULL,
    `evaluatedAt` DATETIME(3) NULL,
    `certificateUrl` TEXT NULL,
    `abcSubmittedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Internship_mentorTokenHash_key`(`mentorTokenHash`),
    INDEX `Internship_collegeId_status_idx`(`collegeId`, `status`),
    INDEX `Internship_candidateId_idx`(`candidateId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InternshipLog` (
    `id` VARCHAR(191) NOT NULL,
    `internshipId` VARCHAR(191) NOT NULL,
    `weekStart` DATETIME(3) NOT NULL,
    `hours` INTEGER NOT NULL,
    `summary` TEXT NOT NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewerNote` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `InternshipLog_internshipId_weekStart_key`(`internshipId`, `weekStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReadinessCheck` (
    `id` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `scores` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReadinessCheck_candidateId_createdAt_idx`(`candidateId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AptitudeQuestion` (
    `id` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NULL,
    `section` ENUM('QUANT', 'REASONING', 'VERBAL', 'TECHNICAL') NOT NULL,
    `topic` VARCHAR(191) NOT NULL,
    `difficulty` INTEGER NOT NULL DEFAULT 2,
    `pattern` VARCHAR(191) NULL,
    `stem` TEXT NOT NULL,
    `options` JSON NOT NULL,
    `answerIndex` INTEGER NOT NULL,
    `explanation` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AptitudeQuestion_section_topic_idx`(`section`, `topic`),
    INDEX `AptitudeQuestion_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AptitudeAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `questionId` VARCHAR(191) NOT NULL,
    `chosenIndex` INTEGER NOT NULL,
    `correct` BOOLEAN NOT NULL,
    `timeMs` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AptitudeAttempt_candidateId_createdAt_idx`(`candidateId`, `createdAt`),
    INDEX `AptitudeAttempt_candidateId_questionId_idx`(`candidateId`, `questionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MockInterviewSession` (
    `id` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `MockInterviewSession_candidateId_createdAt_idx`(`candidateId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MockAnswer` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `question` TEXT NOT NULL,
    `answer` TEXT NOT NULL,
    `durationSec` INTEGER NULL,
    `feedback` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `MockAnswer_sessionId_idx`(`sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Simulation` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `summary` TEXT NOT NULL,
    `estimatedHours` INTEGER NOT NULL DEFAULT 4,
    `skills` JSON NOT NULL,
    `status` ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Simulation_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SimulationTask` (
    `id` VARCHAR(191) NOT NULL,
    `simulationId` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `brief` TEXT NOT NULL,
    `resources` JSON NOT NULL,

    UNIQUE INDEX `SimulationTask_simulationId_order_key`(`simulationId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SimulationEnrolment` (
    `id` VARCHAR(191) NOT NULL,
    `simulationId` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `status` ENUM('IN_PROGRESS', 'SUBMITTED', 'EXPLAIN_BOOKED', 'COMPLETED', 'NEEDS_WORK') NOT NULL DEFAULT 'IN_PROGRESS',
    `explainAt` DATETIME(3) NULL,
    `explainNote` TEXT NULL,
    `reviewedById` VARCHAR(191) NULL,
    `completedAt` DATETIME(3) NULL,
    `certificateCode` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SimulationEnrolment_certificateCode_key`(`certificateCode`),
    UNIQUE INDEX `SimulationEnrolment_simulationId_candidateId_key`(`simulationId`, `candidateId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SimulationSubmission` (
    `id` VARCHAR(191) NOT NULL,
    `enrolmentId` VARCHAR(191) NOT NULL,
    `taskId` VARCHAR(191) NOT NULL,
    `text` TEXT NULL,
    `link` TEXT NULL,
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SimulationSubmission_enrolmentId_taskId_key`(`enrolmentId`, `taskId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CampusStory` (
    `id` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `collegeId` VARCHAR(191) NULL,
    `companyId` VARCHAR(191) NULL,
    `companyName` VARCHAR(191) NOT NULL,
    `kind` ENUM('INTERVIEW', 'INTERN_DIARY', 'FIRST_MONTHS') NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `year` INTEGER NOT NULL,
    `rounds` JSON NOT NULL,
    `body` TEXT NOT NULL,
    `difficulty` INTEGER NULL,
    `result` VARCHAR(191) NULL,
    `anonymous` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('PENDING', 'PUBLISHED', 'HIDDEN') NOT NULL DEFAULT 'PENDING',
    `helpful` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CampusStory_collegeId_status_idx`(`collegeId`, `status`),
    INDEX `CampusStory_companyId_status_idx`(`companyId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShowcaseProfile` (
    `candidateId` VARCHAR(191) NOT NULL,
    `pitch` TEXT NULL,
    `videoUrl` TEXT NULL,
    `pinned` JSON NOT NULL,
    `visibility` ENUM('PRIVATE', 'COLLEGE', 'RECRUITERS') NOT NULL DEFAULT 'PRIVATE',
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`candidateId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShowcaseInvite` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NULL,
    `message` TEXT NOT NULL,
    `status` ENUM('SENT', 'SEEN', 'APPLIED', 'DECLINED') NOT NULL DEFAULT 'SENT',
    `sentById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ShowcaseInvite_candidateId_status_idx`(`candidateId`, `status`),
    INDEX `ShowcaseInvite_companyId_idx`(`companyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmployerRelation` (
    `id` VARCHAR(191) NOT NULL,
    `collegeId` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NULL,
    `companyName` VARCHAR(191) NOT NULL,
    `stage` ENUM('PROSPECT', 'CONTACTED', 'INTERESTED', 'VISITING', 'HIRED', 'DORMANT') NOT NULL DEFAULT 'PROSPECT',
    `priority` INTEGER NOT NULL DEFAULT 2,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `EmployerRelation_collegeId_stage_idx`(`collegeId`, `stage`),
    UNIQUE INDEX `EmployerRelation_collegeId_companyName_key`(`collegeId`, `companyName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmployerContact` (
    `id` VARCHAR(191) NOT NULL,
    `relationId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `designation` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmployerInteraction` (
    `id` VARCHAR(191) NOT NULL,
    `relationId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `summary` TEXT NOT NULL,
    `happenedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `followUpAt` DATETIME(3) NULL,
    `followUpDoneAt` DATETIME(3) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EmployerInteraction_relationId_happenedAt_idx`(`relationId`, `happenedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DriveRoom` (
    `id` VARCHAR(191) NOT NULL,
    `placementId` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `panel` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DriveRoom_placementId_idx`(`placementId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DriveCheckIn` (
    `id` VARCHAR(191) NOT NULL,
    `placementId` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NOT NULL,
    `roomId` VARCHAR(191) NULL,
    `method` VARCHAR(191) NOT NULL,
    `checkedInAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DriveCheckIn_placementId_candidateId_key`(`placementId`, `candidateId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Internship` ADD CONSTRAINT `Internship_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InternshipLog` ADD CONSTRAINT `InternshipLog_internshipId_fkey` FOREIGN KEY (`internshipId`) REFERENCES `Internship`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReadinessCheck` ADD CONSTRAINT `ReadinessCheck_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AptitudeAttempt` ADD CONSTRAINT `AptitudeAttempt_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AptitudeAttempt` ADD CONSTRAINT `AptitudeAttempt_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `AptitudeQuestion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MockInterviewSession` ADD CONSTRAINT `MockInterviewSession_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MockAnswer` ADD CONSTRAINT `MockAnswer_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `MockInterviewSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Simulation` ADD CONSTRAINT `Simulation_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SimulationTask` ADD CONSTRAINT `SimulationTask_simulationId_fkey` FOREIGN KEY (`simulationId`) REFERENCES `Simulation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SimulationEnrolment` ADD CONSTRAINT `SimulationEnrolment_simulationId_fkey` FOREIGN KEY (`simulationId`) REFERENCES `Simulation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SimulationEnrolment` ADD CONSTRAINT `SimulationEnrolment_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SimulationSubmission` ADD CONSTRAINT `SimulationSubmission_enrolmentId_fkey` FOREIGN KEY (`enrolmentId`) REFERENCES `SimulationEnrolment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SimulationSubmission` ADD CONSTRAINT `SimulationSubmission_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `SimulationTask`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampusStory` ADD CONSTRAINT `CampusStory_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShowcaseProfile` ADD CONSTRAINT `ShowcaseProfile_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShowcaseInvite` ADD CONSTRAINT `ShowcaseInvite_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShowcaseInvite` ADD CONSTRAINT `ShowcaseInvite_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmployerContact` ADD CONSTRAINT `EmployerContact_relationId_fkey` FOREIGN KEY (`relationId`) REFERENCES `EmployerRelation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmployerInteraction` ADD CONSTRAINT `EmployerInteraction_relationId_fkey` FOREIGN KEY (`relationId`) REFERENCES `EmployerRelation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DriveCheckIn` ADD CONSTRAINT `DriveCheckIn_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

