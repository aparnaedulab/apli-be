-- What a student chose the last time they built a resume in the portal:
-- which sections, in what order, which projects, and the summary they wrote.
--
-- Nullable rather than defaulted: a student who has only ever uploaded a PDF
-- has made no choices, and "no choices yet" is a different thing from "chose
-- nothing", which is what an empty object would say.
ALTER TABLE `Candidate` ADD COLUMN `resumeBuild` JSON NULL;
