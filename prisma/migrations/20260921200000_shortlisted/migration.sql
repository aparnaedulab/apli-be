-- Shortlisted: picked out of the pile, before any round has happened.
--
-- Distinct from IN_ROUND on purpose. A campus drive shortlists from the
-- applications, tells those students they are through, and only then calls
-- them to a date and a place. Folding the two into one state meant the
-- portal could only ever send the second message.
--
-- The value is added after UNDER_REVIEW so the column reads in pipeline
-- order. MySQL rewrites the enum in place; no row changes value.
--
-- utf8mb4_unicode_ci to match every other table here - the newer
-- utf8mb4_0900_ai_ci would be a second collation in one schema.

ALTER TABLE `Application`
  MODIFY `status` ENUM(
    'APPLIED',
    'UNDER_REVIEW',
    'SHORTLISTED',
    'IN_ROUND',
    'WAITLISTED',
    'OFFERED',
    'ACCEPTED',
    'DECLINED',
    'HIRED',
    'REJECTED',
    'WITHDRAWN'
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'APPLIED';

-- The audit trail records both ends of every move, so it needs the value too.
ALTER TABLE `StatusEvent`
  MODIFY `fromStatus` ENUM(
    'APPLIED',
    'UNDER_REVIEW',
    'SHORTLISTED',
    'IN_ROUND',
    'WAITLISTED',
    'OFFERED',
    'ACCEPTED',
    'DECLINED',
    'HIRED',
    'REJECTED',
    'WITHDRAWN'
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL;

ALTER TABLE `StatusEvent`
  MODIFY `toStatus` ENUM(
    'APPLIED',
    'UNDER_REVIEW',
    'SHORTLISTED',
    'IN_ROUND',
    'WAITLISTED',
    'OFFERED',
    'ACCEPTED',
    'DECLINED',
    'HIRED',
    'REJECTED',
    'WITHDRAWN'
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;
