-- A feed post is written in the same rich-text box a company post is, so the
-- column holds HTML and is named for what it holds. Sanitised on the way in
-- against the allowlist in postHtml.ts, never on the way out.
ALTER TABLE `Post` CHANGE `body` `bodyHtml` TEXT NOT NULL;
