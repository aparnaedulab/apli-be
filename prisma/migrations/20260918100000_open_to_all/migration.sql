-- A role with no marks bar at all, said rather than inferred from blanks.
ALTER TABLE `Job` ADD COLUMN `openToAll` BOOLEAN NOT NULL DEFAULT false;
