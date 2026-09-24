-- A finer permission catalogue.
--
-- The old set lumped together things different people should be given
-- separately: `roster:write` covered adding a batch and adding a student, and
-- there was no way to say "adds a company" without also saying "vets one".
--
-- Nobody loses reach. Each role is rewritten to the new permissions that cover
-- the same ground it covered before, and the roles this university made for
-- itself go through the same mapping as the ones we ship.
--
--   roster:read   -> batch:read, student:read, drive:read, posting:read,
--                    job:read, application:read, report:read
--   roster:write  -> batch:write, student:write, student:invite
--   roster:verify -> student:verify
--   offer:decide  -> offer:make              (renamed)
--   user:manage   -> login:manage, account:suspend
--   college:write -> college:read, college:write
--   company:verify-> company:read, company:verify

-- Cleared first so that anything the mapping below misses ends up visibly
-- empty rather than holding stale permission names that now mean nothing.
UPDATE `PlatformRole` SET `permissions` = JSON_ARRAY();

-- --- the roles we ship ------------------------------------------------------
UPDATE `PlatformRole` SET `permissions` = '["batch:read","batch:write","batch:delete","student:read","student:write","student:verify","student:invite","student:remove","drive:read","drive:write","posting:read","posting:decide","application:read","application:advance","report:read","report:export","team:manage"]'
  WHERE `key` = 'campus.officer';

UPDATE `PlatformRole` SET `permissions` = '["batch:read","batch:write","student:read","student:write","student:invite","drive:read","drive:write","posting:read","posting:decide","application:read","application:advance","report:read"]'
  WHERE `key` = 'campus.coordinator';

UPDATE `PlatformRole` SET `permissions` = '["batch:read","student:read","drive:read","posting:read","application:read","report:read"]'
  WHERE `key` = 'campus.viewer';

UPDATE `PlatformRole` SET `permissions` = '["job:read","job:write","job:publish","posting:target","application:read","application:advance","offer:make","report:read","report:export","team:manage"]'
  WHERE `key` = 'company.owner';

UPDATE `PlatformRole` SET `permissions` = '["job:read","job:write","posting:target","application:read","application:advance","report:read"]'
  WHERE `key` = 'company.recruiter';

UPDATE `PlatformRole` SET `permissions` = '["application:read","application:advance"]'
  WHERE `key` = 'company.interviewer';

UPDATE `PlatformRole` SET `permissions` = '["college:read","college:write","college:archive","company:read","company:write","company:verify","batch:read","batch:write","batch:delete","student:read","student:write","student:verify","student:invite","student:remove","drive:read","posting:read","job:read","application:read","report:read","report:export","login:manage","role:manage","account:suspend","settings:write","audit:read"]'
  WHERE `key` = 'admin.super';

-- A university that already made its own "University admin" would collide with
-- the rename below, because a name is unique within its world. Theirs moves
-- aside rather than being overwritten - it is their role, and they should be
-- the one to decide what it is finally called.
UPDATE `PlatformRole`
SET `name` = CONCAT(`name`, ' (yours)')
WHERE `key` IS NULL
  AND `scope` = 'ADMIN'
  AND `name` = 'University admin'
  AND EXISTS (SELECT 1 FROM (SELECT * FROM `PlatformRole`) r WHERE r.`key` = 'admin.operations');

-- Operations becomes University admin: the same job, under a name that says it.
UPDATE `PlatformRole`
SET `key` = 'admin.university',
    `name` = 'University admin',
    `description` = 'Runs the portal day to day: colleges, companies, rosters and reports. Cannot change roles or settings, or deactivate accounts.',
    `permissions` = '["college:read","college:write","company:read","company:write","company:verify","batch:read","batch:write","student:read","student:write","student:invite","drive:read","posting:read","job:read","application:read","report:read","report:export","login:manage","audit:read"]'
WHERE `key` = 'admin.operations';

-- --- the roles this university made for itself ------------------------------
--
-- Matched by the name they were created with, and mapped by the same rules.
UPDATE `PlatformRole` SET `permissions` = '["batch:read","batch:write","student:read","student:write","student:verify","student:invite","drive:read","drive:write","posting:read","posting:decide","application:read","application:advance","report:read","team:manage"]'
  WHERE `key` IS NULL AND `scope` = 'CAMPUS' AND `name` = 'College admin';

UPDATE `PlatformRole` SET `permissions` = '["batch:read","student:read","student:verify"]'
  WHERE `key` IS NULL AND `scope` = 'CAMPUS' AND `name` = 'Verifier';

UPDATE `PlatformRole` SET `permissions` = '["job:read","job:write","job:publish","posting:target","application:read","application:advance","offer:make","report:read","team:manage"]'
  WHERE `key` IS NULL AND `scope` = 'COMPANY' AND `name` = 'Company admin';

UPDATE `PlatformRole` SET `permissions` = '["college:read","college:write","company:read","company:verify","batch:read","student:read","application:read","report:read","audit:read"]'
  WHERE `key` IS NULL AND `scope` = 'ADMIN' AND `name` IN ('University admin', 'University admin (yours)');

-- A role left with nothing would silently stop working for whoever holds it.
-- Retire those instead, so somebody sees it and decides what it should hold.
UPDATE `PlatformRole`
SET `isActive` = false,
    `description` = CONCAT(
      COALESCE(`description`, ''),
      ' (Retired automatically: its permissions predate the current catalogue. Edit it and turn it back on.)'
    )
WHERE JSON_LENGTH(`permissions`) = 0;
