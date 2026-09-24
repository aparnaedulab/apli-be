-- The student's side of a micro-internship payment, kept on the application
-- itself rather than inferred from a notification.
ALTER TABLE `MicroApplication` ADD COLUMN `paymentConfirmedAt` DATETIME(3) NULL;
