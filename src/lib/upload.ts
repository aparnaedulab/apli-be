import multer from 'multer';

/**
 * Spreadsheet uploads, everywhere.
 *
 * Held in memory and never written to disk: a class list of a few hundred rows
 * is tiny, and a file that never lands on the filesystem is one fewer thing to
 * clean up or leak.
 */
export const workbookUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /\.(xlsx|csv)$/i.test(file.originalname) ||
      [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'text/csv',
      ].includes(file.mimetype);
    cb(null, ok);
  },
});

/**
 * Image uploads: an institution's logo and favicon, a company's pictures.
 *
 * Held in memory only long enough to check what the bytes actually are; the
 * browser's claimed type is a hint, never trusted on its own.
 *
 * The ceiling is the largest any kind allows - a photograph. What each kind
 * actually allows is decided in assets.ts, which can say so in a sentence a
 * person can act on; multer can only cut the connection.
 */
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
});

/**
 * What goes inside a post: a picture or a short video.
 *
 * A separate ceiling from `imageUpload` so that raising it for video does not
 * quietly let somebody push fifty megabytes through the logo field. Which of
 * the two a request may use is decided by the route, and what the file
 * actually is, is decided in assets.ts by reading the bytes.
 */
export const postMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

/**
 * A document a student uploads about themselves - today, a resume.
 *
 * Its own ceiling again, so that what a resume may weigh has nothing to do
 * with what a company's cover picture may weigh. What the file actually is,
 * is decided in assets.ts by reading the bytes.
 */
export const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

/** The headers that make a browser save a generated workbook rather than show it. */
export function asWorkbook(filename: string): Record<string, string> {
  return {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
  };
}
