-- The icon in the browser tab, alongside the logo. Nullable: an institution
-- without one simply shows the platform's own.
ALTER TABLE `Tenant` ADD COLUMN `faviconUrl` TEXT NULL;
