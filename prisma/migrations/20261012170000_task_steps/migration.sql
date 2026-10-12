-- AlterTable
ALTER TABLE `WorkSimulationTask` ADD COLUMN `steps` JSON NOT NULL;

-- Tasks written before this have no steps yet: an empty list, not null.
UPDATE `WorkSimulationTask` SET `steps` = JSON_ARRAY();
