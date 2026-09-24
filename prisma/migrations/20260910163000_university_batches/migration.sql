-- A batch may belong to the university rather than to one college.
--
-- Nothing existing changes: every batch on the platform today keeps its
-- college, and a college's drive still only offers that college's own batches,
-- so a university-wide batch cannot be pulled into one by accident.
ALTER TABLE `Batch` DROP FOREIGN KEY `Batch_collegeId_fkey`;

ALTER TABLE `Batch` MODIFY `collegeId` VARCHAR(191) NULL;

ALTER TABLE `Batch` ADD CONSTRAINT `Batch_collegeId_fkey`
    FOREIGN KEY (`collegeId`) REFERENCES `College`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
