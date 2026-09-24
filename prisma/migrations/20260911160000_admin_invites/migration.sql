-- Operations logins can be invited like anybody else.
--
-- Until now the only admin account came from a command-line script, which
-- meant a university could not add a second one without a developer. The
-- invitation path is the same as every other: a one-time link, and the person
-- sets their own password.
ALTER TABLE `Invite`
    MODIFY `kind` ENUM('STUDENT', 'CAMPUS_MEMBER', 'COMPANY_MEMBER', 'ADMIN_MEMBER') NOT NULL;
