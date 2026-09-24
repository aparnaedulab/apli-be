-- Each WhatsApp message points at the notification it copies, so a restart
-- or a second dispatcher run can never send the same one twice.
ALTER TABLE `WhatsAppMessage` ADD COLUMN `notificationId` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `WhatsAppMessage_notificationId_key` ON `WhatsAppMessage`(`notificationId`);
