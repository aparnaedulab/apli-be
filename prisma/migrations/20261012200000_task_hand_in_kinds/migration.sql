-- AlterTable
ALTER TABLE `WorkSimulationTask` ADD COLUMN `handInKinds` JSON NOT NULL;

-- Tasks written before this took all three; they still do.
UPDATE `WorkSimulationTask` SET `handInKinds` = JSON_ARRAY('text', 'link', 'file');
