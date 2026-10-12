-- Whether a student signing up at the institution's colleges gets a welcome email.
ALTER TABLE `Tenant` ADD COLUMN `studentWelcomeEmail` BOOLEAN NOT NULL DEFAULT false;
