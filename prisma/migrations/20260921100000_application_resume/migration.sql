-- The resume an application carried, frozen when it was sent.
--
-- A student may keep several resumes and change which one is current. Reading
-- their current one meant an application silently changed what it carried
-- every time they switched - so a recruiter could open a different document
-- from the one they were sent.
--
-- Nullable: applications made before this was recorded have no answer, and
-- fall back to the candidate's current resume rather than showing nothing.
ALTER TABLE `Application` ADD COLUMN `resumeUrl` VARCHAR(191) NULL;
