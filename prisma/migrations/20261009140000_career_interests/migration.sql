-- Career interests become a list the platform team keeps.
ALTER TABLE `RefValue` MODIFY `kind` ENUM('CITY', 'STATE', 'NAAC_GRADE', 'GENDER', 'CAREER_INTEREST') NOT NULL;

-- The list sign-up offered when it was fixed in code, so nothing changes for students.
INSERT IGNORE INTO `RefValue` (`id`, `kind`, `value`, `isActive`, `position`, `createdAt`) VALUES
    (UUID(), 'CAREER_INTEREST', 'Software', true, 0, CURRENT_TIMESTAMP(3)),
    (UUID(), 'CAREER_INTEREST', 'Data', true, 1, CURRENT_TIMESTAMP(3)),
    (UUID(), 'CAREER_INTEREST', 'Design', true, 2, CURRENT_TIMESTAMP(3)),
    (UUID(), 'CAREER_INTEREST', 'Finance', true, 3, CURRENT_TIMESTAMP(3)),
    (UUID(), 'CAREER_INTEREST', 'Marketing', true, 4, CURRENT_TIMESTAMP(3)),
    (UUID(), 'CAREER_INTEREST', 'Consulting', true, 5, CURRENT_TIMESTAMP(3)),
    (UUID(), 'CAREER_INTEREST', 'Engineering', true, 6, CURRENT_TIMESTAMP(3)),
    (UUID(), 'CAREER_INTEREST', 'Security', true, 7, CURRENT_TIMESTAMP(3)),
    (UUID(), 'CAREER_INTEREST', 'Operations', true, 8, CURRENT_TIMESTAMP(3)),
    (UUID(), 'CAREER_INTEREST', 'Human resources', true, 9, CURRENT_TIMESTAMP(3)),
    (UUID(), 'CAREER_INTEREST', 'Healthcare', true, 10, CURRENT_TIMESTAMP(3)),
    (UUID(), 'CAREER_INTEREST', 'Law', true, 11, CURRENT_TIMESTAMP(3));
