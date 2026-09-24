-- A student's course and branch belong to the student.
ALTER TABLE `Candidate`
    ADD COLUMN `course` VARCHAR(191) NULL,
    ADD COLUMN `specialisation` VARCHAR(191) NULL;

-- Carry across what the batch was standing in for, BEFORE the batch fields
-- become optional. Every student currently on a roster got their course from
-- their batch; that has to keep being true or eligibility silently narrows for
-- everyone already on the platform.
UPDATE `Candidate` c
JOIN `BatchMembership` bm ON bm.`candidateId` = c.`id`
JOIN `Batch` b ON b.`id` = bm.`batchId`
SET c.`course` = b.`course`,
    c.`specialisation` = COALESCE(c.`specialisation`, b.`specialisation`),
    c.`graduationYear` = COALESCE(c.`graduationYear`, b.`graduationYear`)
WHERE c.`course` IS NULL;

-- Now the batch can be as loose as the college needs it to be.
ALTER TABLE `Batch`
    ADD COLUMN `studyYear` INTEGER NULL,
    MODIFY `course` VARCHAR(191) NULL,
    MODIFY `graduationYear` INTEGER NULL;

-- The name alone identifies a batch within a college, because the college
-- chooses the name and a year is no longer guaranteed to exist.
DROP INDEX `Batch_collegeId_name_graduationYear_key` ON `Batch`;
CREATE UNIQUE INDEX `Batch_collegeId_name_key` ON `Batch`(`collegeId`, `name`);
