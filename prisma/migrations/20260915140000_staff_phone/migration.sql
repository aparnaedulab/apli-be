-- A phone number for everyone, not only students.
--
-- A student's number lives on their Candidate record because the college
-- enters it with the rest of the roster. Staff had nowhere to put one at all,
-- which meant an invitation that never arrived left nobody to call.
ALTER TABLE `User` ADD COLUMN `phone` VARCHAR(191) NULL;

-- Captured when the invitation is written, and copied onto the account when it
-- is accepted, so the person is not asked for what was already known.
ALTER TABLE `Invite` ADD COLUMN `invitedPhone` VARCHAR(191) NULL;
