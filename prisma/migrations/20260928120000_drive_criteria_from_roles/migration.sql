-- A drive no longer holds a bar of its own.
--
-- It carried one for the eligibility report while the Job carried the one
-- that gated applications: two sets of numbers about a single question, which
-- the schema comment conceded would drift. The report now reads the drive's
-- roles, so a recruiter is shown the rule that will actually be applied.
ALTER TABLE `CampusDrive`
  DROP COLUMN `minCgpa`,
  DROP COLUMN `minDegreePct`,
  DROP COLUMN `maxBacklogs`,
  DROP COLUMN `maxActiveBacklogs`;

DROP TABLE `CampusDriveCourse`;
DROP TABLE `CampusDriveBranch`;
DROP TABLE `CampusDriveGradYear`;
