-- An invitation can now activate an account that already exists, rather than
-- always creating one. This is what lets a placement officer enter a class list
-- up front: the student records appear on the roster straight away, and each
-- student claims their own login afterwards.

ALTER TABLE `Invite` ADD COLUMN `userId` VARCHAR(191) NULL;

CREATE INDEX `Invite_userId_idx` ON `Invite`(`userId`);

ALTER TABLE `Invite` ADD CONSTRAINT `Invite_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
