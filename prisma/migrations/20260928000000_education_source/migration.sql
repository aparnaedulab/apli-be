-- Who put a row on a student's profile. A qualification the college entered
-- from its records is read-only to the student, the same as a verified mark;
-- everything they listed themselves stays theirs to change.
ALTER TABLE `Education`
  ADD COLUMN `source` ENUM('STUDENT', 'COLLEGE') NOT NULL DEFAULT 'STUDENT';
