-- Each course says its level and length; each student, the year they joined.
ALTER TABLE `Course` ADD COLUMN `level` ENUM('DIPLOMA', 'UG', 'PG', 'PHD') NULL,
    ADD COLUMN `years` INTEGER NULL;

ALTER TABLE `Candidate` ADD COLUMN `startYear` INTEGER NULL;

-- The common courses, filled in so sign-up works on day one. Anything else
-- is set in onboarding.
UPDATE `Course` SET `level` = 'UG', `years` = 4 WHERE `name` IN ('B.Tech', 'B.E.', 'BE', 'B.Arch', 'B.Pharm', 'B.Des');
UPDATE `Course` SET `level` = 'UG', `years` = 3 WHERE `name` IN ('B.Sc', 'B.Com', 'BA', 'B.A.', 'BBA', 'BCA', 'BMS', 'BAF', 'BMM');
UPDATE `Course` SET `level` = 'UG', `years` = 5 WHERE `name` IN ('MBBS', 'LLB (5 years)', 'BA LLB', 'BBA LLB');
UPDATE `Course` SET `level` = 'PG', `years` = 2 WHERE `name` IN ('M.Tech', 'M.E.', 'MCA', 'MBA', 'PGDM', 'M.Sc', 'M.Com', 'MA', 'M.A.');
UPDATE `Course` SET `level` = 'DIPLOMA', `years` = 3 WHERE `name` LIKE 'Diploma%' AND `level` IS NULL;
UPDATE `Course` SET `level` = 'PHD', `years` = 4 WHERE `name` LIKE 'Ph%D%' AND `level` IS NULL;
