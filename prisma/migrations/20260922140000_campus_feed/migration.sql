-- The campus feed.
--
-- Fenced at the college, like everything else here: a story is read only by
-- its own college's students, a job is seen only where the cell accepted it.
-- `collegeId` is not a label on a post - it is who the post is for, which is
-- why it is NOT NULL and indexed with the sort order the feed reads in.
--
-- utf8mb4_unicode_ci throughout, to match every other table in this schema.

CREATE TABLE `Post` (
  `id`          VARCHAR(191) NOT NULL,
  `collegeId`   VARCHAR(191) NOT NULL,
  `authorId`    VARCHAR(191) NOT NULL,
  `authorKind`  ENUM('STUDENT','COLLEGE','COMPANY')
                CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
                NOT NULL DEFAULT 'STUDENT',
  `body`        TEXT NOT NULL,
  `media`       JSON NOT NULL,
  -- Taken down rather than deleted, so a removal can be answered for.
  `removedAt`   DATETIME(3) NULL,
  `removedById` VARCHAR(191) NULL,
  `removedWhy`  TEXT NULL,
  `createdAt`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`   DATETIME(3) NOT NULL,

  INDEX `Post_collegeId_createdAt_idx` (`collegeId`, `createdAt`),
  INDEX `Post_authorId_idx` (`authorId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PostComment` (
  `id`        VARCHAR(191) NOT NULL,
  `postId`    VARCHAR(191) NOT NULL,
  `authorId`  VARCHAR(191) NOT NULL,
  `body`      TEXT NOT NULL,
  `removedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `PostComment_postId_createdAt_idx` (`postId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One person, one like, one post: the pair is the key.
CREATE TABLE `PostLike` (
  `postId`    VARCHAR(191) NOT NULL,
  `userId`    VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `PostLike_userId_idx` (`userId`),
  PRIMARY KEY (`postId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Post`
  ADD CONSTRAINT `Post_collegeId_fkey` FOREIGN KEY (`collegeId`)
    REFERENCES `College`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `Post_authorId_fkey` FOREIGN KEY (`authorId`)
    REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PostComment`
  ADD CONSTRAINT `PostComment_postId_fkey` FOREIGN KEY (`postId`)
    REFERENCES `Post`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `PostComment_authorId_fkey` FOREIGN KEY (`authorId`)
    REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PostLike`
  ADD CONSTRAINT `PostLike_postId_fkey` FOREIGN KEY (`postId`)
    REFERENCES `Post`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `PostLike_userId_fkey` FOREIGN KEY (`userId`)
    REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
