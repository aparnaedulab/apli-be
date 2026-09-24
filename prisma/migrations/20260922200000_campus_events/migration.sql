-- A campus week becomes an event either side can create.
-- `companyId` null means the college is running it itself.
ALTER TABLE `CampusWeek` MODIFY `companyId` VARCHAR(191) NULL;

-- The role a session is about, where it is about one.
ALTER TABLE `CampusWeekEvent` ADD COLUMN `jobId` VARCHAR(191) NULL;

-- How a student came to be on a session's list, and whether they said yes.
-- Every existing row was a student who registered themselves, so GOING is
-- the correct value for all of them.
ALTER TABLE `CampusWeekRegistration`
  ADD COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'GOING',
  ADD COLUMN `invitedAt` DATETIME(3) NULL;
