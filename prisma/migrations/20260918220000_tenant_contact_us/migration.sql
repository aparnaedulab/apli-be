-- "Contact us": what an institution publishes to its students and recruiters,
-- separate from the private account contact the platform team talks to.
ALTER TABLE `Tenant`
  ADD COLUMN `supportEmail` VARCHAR(191) NULL,
  ADD COLUMN `supportPhone` VARCHAR(191) NULL,
  ADD COLUMN `supportAltPhone` VARCHAR(191) NULL,
  ADD COLUMN `supportWhatsapp` VARCHAR(191) NULL,
  ADD COLUMN `officeHours` VARCHAR(191) NULL;
