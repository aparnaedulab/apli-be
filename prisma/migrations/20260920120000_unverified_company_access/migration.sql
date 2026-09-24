-- Each institution decides during onboarding whether a company that has just
-- registered waits for verification before it can sign in, or gets in at once
-- and drafts while it waits.
ALTER TABLE `Tenant` ADD COLUMN `unverifiedCompanyAccess` BOOLEAN NOT NULL DEFAULT false;
