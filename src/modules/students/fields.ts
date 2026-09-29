/**
 * The student record, declared once.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists
 *
 * The same facts about a student arrive by two doors: a college uploads a
 * class list, or the student fills in their own profile. Those two doors were
 * built at different times against two hand-written lists of fields, and they
 * drifted - as two hand-written lists always do:
 *
 *   - the profile bounded the graduating year, backlogs and gap years; the
 *     import took any number at all
 *   - the profile refused a course its college does not run; the import
 *     accepted it and quietly left the student mapped to nothing
 *   - the import required a mobile number with ten digits in it; the profile
 *     let a student blank it
 *   - the profile offered gender as a list; the import took free text
 *   - `isLateralEntry` could only ever be set by the student, although the
 *     column that exists solely for lateral entrants - Diploma % - was on the
 *     import all along
 *
 * None of that was decided. It accumulated. So the fields are declared here,
 * once, and both doors are generated from this list: the spreadsheet columns
 * and their help notes, the header aliases a pasted sheet is matched on, the
 * validation on each side, and the set of facts that lock when a college
 * verifies a student.
 *
 * ---------------------------------------------------------------------------
 * What is here and what is not
 *
 * Every field that both doors can write, plus the ones only an institution
 * writes. A field only the student can ever set - their headline, their
 * projects, a resume, what travel they will accept, a disability they choose
 * to declare - is not here, because it has no second door to agree with. Those
 * stay declared where they are used, in the profile's own schema.
 *
 * `owner` says which door writes it:
 *
 *   institution  the college or university writes it; the student reads it
 *   shared       both write it, and the institution wins once it has verified
 */

/** Who writes a field. */
export type FieldOwner = 'institution' | 'shared';

/**
 * How a value is read and bounded.
 *
 * The import always receives a string, whatever this says, because a
 * spreadsheet cell is a string. The type is what it is turned into and what
 * it is checked against - on both sides, so neither can be laxer.
 */
export type FieldType = 'text' | 'email' | 'phone' | 'int' | 'decimal' | 'date' | 'bool' | 'list';

export interface StudentField {
  /** The column on `Candidate`, or the relation it resolves to. */
  key: string;
  owner: FieldOwner;

  /** The spreadsheet column header. */
  header: string;
  /**
   * Other spellings a pasted sheet might use, already normalised - lower
   * case, letters and digits only. A placement officer should not have to
   * reformat a sheet they did not write.
   */
  aliases: readonly string[];
  /** The label on the student's own form. */
  label: string;
  /** Said once, and used for both the spreadsheet cell note and the form hint. */
  note: string;

  type: FieldType;
  /** Character limit, for the text kinds. */
  maxLength?: number;
  /** Bounds, for the number kinds. Inclusive. */
  min?: number;
  max?: number;

  /** Which vocabulary a `list` field is checked against. */
  list?: 'GENDER';

  /**
   * Required to create a student. Only ever true for the three facts that
   * make a roster row usable at all.
   *
   * Requiredness is the one thing the two doors are allowed to differ on: the
   * import is creating a record that somebody has to be able to reach, the
   * profile is editing one that already exists. The *format* check is the
   * same either way.
   */
  requiredOnImport?: boolean;

  /** Only on the university-level sheet, which spans colleges. */
  universityOnly?: boolean;

  /**
   * A column that resolves to other columns rather than being one itself.
   *
   * Programme is the only one: it stands for the course-and-branch pair,
   * which is what a college actually runs. It has no column of its own on
   * `Candidate` - it sets `course`, `specialisation` and `collegeProgramId`.
   */
  virtual?: boolean;

  /**
   * Set by another field rather than configured in its own right.
   *
   * `course` and `specialisation` are the two names a programme resolves
   * to. They are still stored, still read by eligibility and still locked
   * on verification - but an institution chooses whether it collects a
   * *programme*, not whether it collects half of one. So they do not appear
   * on the policy screen and are not asked for on a form.
   */
  configuredBy?: string;

  /**
   * Whether the workbook prints it. Course and Branch are still *accepted* -
   * every sheet already in circulation has them - but the template offers
   * the single Programme column instead, because a college runs pairs and
   * two independent columns invite a combination that is half right.
   */
  printOnTemplate?: boolean;

  /** What the Example sheet shows, for the two sample students. */
  examples: readonly [string, string];

  /** Column width in the workbook. */
  width: number;

  /**
   * Whether a role's eligibility reads this.
   *
   * Everything true here is a fact a company filters on, which is what makes
   * it worth verifying - and what makes it dangerous to leave editable after
   * verification. The invariant is enforced by a test rather than by a
   * comment: see `lockOnVerify`.
   */
  readsEligibility?: boolean;

  /**
   * Whether a verified student may still change it.
   *
   * A field that eligibility reads must either lock here or say in
   * `lockExemptBecause` why it does not. That is the whole point of the pair:
   * six fields were added to eligibility over time and none of them was added
   * to the lock, because nothing forced anybody to decide.
   */
  lockOnVerify?: boolean;
  /** Required when `readsEligibility` is set and `lockOnVerify` is not. */
  lockExemptBecause?: string;
}

/**
 * Every field, in the order the spreadsheet prints them.
 *
 * The order is the column order, so moving a row here moves the column. The
 * examples travel with their field rather than sitting in a parallel array of
 * positional strings, which is how the Example sheet used to fall one column
 * out of step with the Students sheet.
 */
const FIELDS = [
  {
    key: 'fullName',
    owner: 'institution',
    header: 'Name',
    aliases: ['name', 'fullname', 'studentname', 'student'],
    label: 'Full name',
    note: 'The student’s full name, as it should appear to recruiters.',
    type: 'text',
    maxLength: 120,
    requiredOnImport: true,
    examples: ['Aditi Rane', 'Kunal Deshmukh'],
    width: 24,
  },
  {
    key: 'email',
    owner: 'institution',
    header: 'Email',
    aliases: ['email', 'emailid', 'emailaddress', 'mail'],
    label: 'Email',
    note: 'Their own address. The activation link goes here, and it is how they sign in.',
    type: 'email',
    maxLength: 200,
    requiredOnImport: true,
    examples: ['aditi.rane@pict.demo-college.example', 'kunal.d@pict.demo-college.example'],
    width: 30,
  },
  {
    key: 'phone',
    owner: 'shared',
    header: 'Mobile',
    aliases: ['phone', 'mobile', 'mobileno', 'contact', 'contactno', 'phoneno'],
    label: 'Mobile',
    note: 'Ten digits. +91, spaces and dashes are all fine.',
    type: 'phone',
    maxLength: 24,
    requiredOnImport: true,
    examples: ['9000000023', '9000000024'],
    width: 16,
  },
  {
    key: 'college',
    owner: 'institution',
    header: 'College code',
    aliases: ['college', 'collegecode', 'institute', 'institutecode'],
    label: 'College',
    note: 'The college’s short code, from the "Colleges" sheet. Leave blank if the college is not known yet - the student can be placed in one later, from Map data.',
    type: 'text',
    maxLength: 200,
    universityOnly: true,
    examples: ['PICT', 'PICT'],
    width: 14,
  },
  {
    key: 'batch',
    owner: 'institution',
    header: 'Batch',
    aliases: ['batch', 'class', 'batchname'],
    label: 'Batch',
    note: 'Which group they belong to. Pick one from the list, or type a new name and it will be created.',
    type: 'text',
    maxLength: 120,
    examples: ['CSE 2026', 'CSE 2026'],
    width: 22,
  },
  {
    key: 'programme',
    owner: 'shared',
    virtual: true,
    header: 'Programme',
    aliases: ['programme', 'program', 'courseandbranch', 'programmename'],
    label: 'Programme',
    note: 'Pick one of the programmes this college runs. A college runs course-and-branch pairs, so choosing the pair is the only way to be sure it is right - a course with the branch left blank is the commonest thing that goes wrong here.',
    type: 'text',
    maxLength: 200,
    examples: ['B.Tech — Computer Science', 'B.Tech — Computer Science'],
    width: 34,
  },
  {
    key: 'course',
    owner: 'shared',
    // Still read from any sheet that has it; no longer printed, because
    // Programme above says the same thing and cannot be half right.
    printOnTemplate: false,
    configuredBy: 'programme',
    header: 'Course',
    aliases: ['course', 'coursename', 'degree'],
    label: 'Course',
    note: 'B.Tech, MCA, MBA. This is the student’s own course - recruiters filter on it.',
    type: 'text',
    maxLength: 120,
    readsEligibility: true,
    lockOnVerify: true,
    examples: ['B.Tech', 'B.Tech'],
    width: 14,
  },
  {
    key: 'specialisation',
    owner: 'shared',
    printOnTemplate: false,
    configuredBy: 'programme',
    header: 'Branch',
    aliases: ['specialisation', 'specialization', 'branch', 'stream'],
    label: 'Branch',
    note: 'Computer Science, Mechanical, Finance.',
    type: 'text',
    maxLength: 120,
    readsEligibility: true,
    lockOnVerify: true,
    examples: ['Computer Science', 'Computer Science'],
    width: 26,
  },
  {
    key: 'graduationYear',
    owner: 'shared',
    header: 'Graduating year',
    aliases: ['year', 'graduationyear', 'graduatingyear', 'passingyear', 'passoutyear', 'batchyear'],
    label: 'Graduating year',
    note: 'Four digits. Recruiters filter on it, so it is worth filling in.',
    type: 'int',
    min: 2000,
    max: 2100,
    readsEligibility: true,
    lockOnVerify: true,
    examples: ['2026', '2026'],
    width: 16,
  },
  {
    key: 'rollNo',
    owner: 'institution',
    header: 'Roll No',
    aliases: ['rollno', 'roll', 'rollnumber'],
    label: 'Roll number',
    note: 'The college roll number. Unique within a batch.',
    type: 'text',
    maxLength: 40,
    examples: ['CS22-101', 'CS22-102'],
    width: 14,
  },
  {
    key: 'prn',
    owner: 'institution',
    header: 'PRN',
    aliases: [
      'prn',
      'enrolmentno',
      'enrollmentno',
      'enrolmentnumber',
      'registrationno',
      'universityid',
    ],
    label: 'PRN',
    note: 'The university registration number. Unique across the whole platform.',
    type: 'text',
    maxLength: 40,
    examples: ['72012301K', '72012302K'],
    width: 18,
  },
  {
    key: 'division',
    owner: 'institution',
    header: 'Div',
    aliases: ['division', 'div', 'section'],
    label: 'Division',
    note: 'Division or section, if you use them.',
    type: 'text',
    maxLength: 20,
    examples: ['A', 'A'],
    width: 8,
  },
  {
    key: 'gender',
    owner: 'shared',
    header: 'Gender',
    aliases: ['gender', 'sex'],
    label: 'Gender',
    note: 'From the list operations keeps. A role open to one gender only reads this, so a spelling nobody else uses makes that role invisible.',
    type: 'list',
    list: 'GENDER',
    maxLength: 30,
    readsEligibility: true,
    // Recorded or blank are distinguishable, so the same rule as course and
    // branch applies: a value the college recorded is locked, a blank the
    // student may still fill in.
    lockOnVerify: true,
    examples: ['Female', 'Male'],
    width: 12,
  },
  {
    key: 'dateOfBirth',
    owner: 'shared',
    header: 'DOB',
    aliases: ['dob', 'dateofbirth', 'birthdate'],
    label: 'Date of birth',
    note: '2005-04-17 or 17/04/2005. Both are understood.',
    type: 'date',
    examples: ['17/04/2005', '02/11/2004'],
    width: 14,
  },
  {
    key: 'cgpa',
    owner: 'shared',
    header: 'CGPA',
    aliases: ['cgpa', 'gpa', 'sgpa'],
    label: 'CGPA',
    note: 'Out of 10. Recruiters filter on this.',
    type: 'decimal',
    min: 0,
    max: 10,
    readsEligibility: true,
    lockOnVerify: true,
    examples: ['8.6', '7.9'],
    width: 10,
  },
  {
    key: 'degreePct',
    owner: 'shared',
    header: 'Percentage',
    aliases: ['percentage', 'percent', 'degreepercentage', 'aggregate', 'marks'],
    label: 'Degree %',
    note: 'Degree percentage, if your university awards one instead of a CGPA.',
    type: 'decimal',
    min: 0,
    max: 100,
    readsEligibility: true,
    lockOnVerify: true,
    examples: ['', ''],
    width: 12,
  },
  {
    key: 'tenthPct',
    owner: 'shared',
    header: '10th %',
    aliases: ['10th', 'tenth', '10thpercentage', 'sscpercentage', 'ssc', 'x'],
    label: '10th %',
    note: 'SSC percentage.',
    type: 'decimal',
    min: 0,
    max: 100,
    readsEligibility: true,
    lockOnVerify: true,
    examples: ['91', '86'],
    width: 10,
  },
  {
    key: 'twelfthPct',
    owner: 'shared',
    header: '12th %',
    aliases: ['12th', 'twelfth', '12thpercentage', 'hscpercentage', 'hsc', 'xii'],
    label: '12th %',
    note: 'HSC percentage. Leave blank for a student who came through a diploma - fill in Diploma % instead, and a role asking for a 12th will read that.',
    type: 'decimal',
    min: 0,
    max: 100,
    readsEligibility: true,
    lockOnVerify: true,
    examples: ['88', ''],
    width: 10,
  },
  {
    key: 'diplomaPct',
    owner: 'shared',
    header: 'Diploma %',
    aliases: ['diploma', 'diplomapercentage', 'diplomapct', 'diplomamarks'],
    label: 'Diploma %',
    note: 'For lateral-entry students, who have no 12th standard result. Without it, any role that sets a 12th bar is invisible to them.',
    type: 'decimal',
    min: 0,
    max: 100,
    readsEligibility: true,
    lockOnVerify: true,
    examples: ['', '78'],
    width: 11,
  },
  {
    key: 'isLateralEntry',
    owner: 'shared',
    header: 'Lateral entry',
    aliases: ['lateralentry', 'lateral', 'islateralentry', 'directsecondyear', 'dse'],
    label: 'Joined through lateral entry',
    note: 'Yes for a student who joined in the second year through a diploma. A role that does not take lateral entrants hides from them, so it is worth being right.',
    type: 'bool',
    readsEligibility: true,
    // Not locked, deliberately. The column is a boolean with no third state,
    // so a college that never filled it in verifies its whole roster as "not
    // lateral" - and locking that would leave every diploma entrant at that
    // college unable to say otherwise for the rest of their degree. Better a
    // student can correct it than that nobody can.
    lockExemptBecause:
      'A blank column is indistinguishable from a recorded No, so locking it would trap every lateral entrant at a college that left it empty.',
    examples: ['No', 'Yes'],
    width: 13,
  },
  {
    key: 'activeBacklogs',
    owner: 'shared',
    header: 'Live backlogs',
    aliases: [
      'activebacklogs',
      'livebacklogs',
      'currentbacklogs',
      'standingarrears',
      'activearrears',
    ],
    label: 'Live backlogs',
    note: 'Still outstanding right now. Almost every criteria sheet says "no live backlogs", and a role asking for it cannot see a student this is blank for.',
    type: 'int',
    min: 0,
    max: 50,
    readsEligibility: true,
    lockOnVerify: true,
    examples: ['0', '1'],
    width: 13,
  },
  {
    key: 'backlogs',
    owner: 'shared',
    header: 'Backlogs (total)',
    aliases: [
      'backlogs',
      'backlog',
      'backlogstotal',
      'totalbacklogs',
      'kt',
      'kts',
      'atkt',
      'deadbacklogs',
    ],
    label: 'Backlogs (total)',
    note: 'Ever accumulated, including ones since cleared. Different from live backlogs - "no live, at most two ever" is one sentence asking for both.',
    type: 'int',
    min: 0,
    max: 50,
    readsEligibility: true,
    lockOnVerify: true,
    examples: ['0', '0'],
    width: 15,
  },
  {
    key: 'pgCgpa',
    owner: 'shared',
    header: 'PG CGPA',
    aliases: ['pgcgpa', 'postgraduationcgpa', 'mastercgpa', 'mtechcgpa', 'mcacgpa'],
    label: 'PG CGPA',
    note: 'Only for a student on a master’s - an MCA, M.Tech or MBA. Their bachelor’s goes in the CGPA column; this is the degree they are on now.',
    type: 'decimal',
    min: 0,
    max: 10,
    readsEligibility: true,
    lockOnVerify: true,
    examples: ['', ''],
    width: 11,
  },
  {
    key: 'pgPct',
    owner: 'shared',
    header: 'PG %',
    aliases: [
      'pg',
      'pgpercentage',
      'pgpct',
      'pgmarks',
      'postgraduationpercentage',
      'masterpercentage',
    ],
    label: 'PG %',
    note: 'The same, where the university awards a percentage rather than a CGPA.',
    type: 'decimal',
    min: 0,
    max: 100,
    readsEligibility: true,
    lockOnVerify: true,
    examples: ['', ''],
    width: 10,
  },
  {
    key: 'gapYears',
    owner: 'shared',
    header: 'Gap years',
    aliases: ['gapyears', 'gap', 'yeargap', 'educationgap', 'breakinstudies'],
    label: 'Gap years',
    note: 'Years out of study. 0 if none. Invisible in a CGPA and asked for constantly.',
    type: 'int',
    min: 0,
    max: 20,
    readsEligibility: true,
    lockOnVerify: true,
    examples: ['0', '1'],
    width: 11,
  },
] as const satisfies readonly StudentField[];

/**
 * The same list, widened.
 *
 * `as const` above is what gives `StudentFieldKey` its literal union - but it
 * also narrows each entry to exactly the properties that entry happens to
 * carry, so `.filter(f => f.lockOnVerify)` stops compiling on the entries
 * that do not set it. Declaring the widened view separately keeps both.
 */
export const STUDENT_FIELDS: readonly StudentField[] = FIELDS;

export type StudentFieldKey = (typeof FIELDS)[number]['key'];

/**
 * The narrow view, for types that need to know which entry is which -
 * whether a field is a number or a yes/no, and who owns it.
 */
export type FieldsConst = typeof FIELDS;

/** By key, for the places that need one field rather than the list. */
export const FIELD_BY_KEY = new Map<string, StudentField>(
  STUDENT_FIELDS.map((f) => [f.key, f]),
);

export const fieldFor = (key: string): StudentField => {
  const f = FIELD_BY_KEY.get(key);
  if (!f) throw new Error(`No student field called "${key}".`);
  return f;
};

/** The fields one door or the other writes. */
export const SHARED_FIELDS = STUDENT_FIELDS.filter((f) => f.owner === 'shared');
export const INSTITUTION_FIELDS = STUDENT_FIELDS.filter((f) => f.owner === 'institution');

/** Everything a spreadsheet carries: both owners, the college column optional. */
export const importFields = (opts: { university?: boolean } = {}): readonly StudentField[] =>
  STUDENT_FIELDS.filter((f) => opts.university || !f.universityOnly);

/** The fields an institution actually chooses about, on the policy screen. */
export const configurableFields = (): readonly StudentField[] =>
  STUDENT_FIELDS.filter((f) => !f.configuredBy);

/** The columns the workbook actually prints. */
export const templateFields = (opts: { university?: boolean } = {}): readonly StudentField[] =>
  importFields(opts).filter((f) => f.printOnTemplate !== false);

/**
 * Header text to field key.
 *
 * One map, shared by the paste box and the workbook reader. Two alias lists is
 * how the template came to print a "Graduating year" column that the paste box
 * then silently ignored.
 */
export const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export const FIELD_BY_HEADER = new Map<string, StudentFieldKey>(
  FIELDS.flatMap((f) =>
    [normalise(f.header), ...f.aliases].map((alias) => [alias, f.key] as [string, StudentFieldKey]),
  ),
);

/* -------------------------------------------------------------------------- */
/* Reading a value, the same way on both sides                                 */
/* -------------------------------------------------------------------------- */

/** What a value turned out to be, or why it could not be used. */
export type Read<T> = { ok: true; value: T | null } | { ok: false; reason: string };

const bad = (reason: string): Read<never> => ({ ok: false, reason });
const ok = <T>(value: T | null): Read<T> => ({ ok: true, value });

/** Accepts 2005-04-17 and 17/04/2005, which is what spreadsheets here produce. */
function readDate(raw: string): Read<Date> {
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  const iso = dmy ? `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}` : raw;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return bad(`"${raw}" is not a date we can read`);
  return ok(parsed);
}

const TRUE = new Set(['yes', 'y', 'true', '1', 'lateral', 'dse']);
const FALSE = new Set(['no', 'n', 'false', '0', '-']);

/**
 * Turns one spreadsheet cell into the value the database holds.
 *
 * Out of range is refused rather than dropped. A CGPA of 12 used to become
 * null, which reads as "no CGPA recorded" - so the student silently failed
 * every CGPA bar and nobody was told why. Saying so is the whole improvement.
 */
export function readCell(field: StudentField, raw: string | undefined): Read<unknown> {
  const value = raw?.trim() ?? '';
  if (!value) return ok(null);

  switch (field.type) {
    case 'text':
    case 'email':
      return value.length > (field.maxLength ?? 255)
        ? bad(`${field.header} is longer than ${field.maxLength} characters`)
        : ok(value);

    case 'phone':
      // Loose on purpose: numbers arrive as 9000000000, +91 90000 00000 and
      // 090000-00000. Ten digits somewhere in there is the only real check.
      return (value.match(/\d/g) ?? []).length < 10
        ? bad(`"${value}" does not look like a mobile number`)
        : ok(value);

    case 'list':
      // The vocabulary lives in the database, so membership is checked by the
      // caller that can read it. Here we only take the text.
      return ok(value);

    case 'date':
      return readDate(value);

    case 'bool': {
      const v = value.toLowerCase();
      if (TRUE.has(v)) return ok(true);
      if (FALSE.has(v)) return ok(false);
      return bad(`${field.header} should be Yes or No, not "${value}"`);
    }

    case 'int': {
      const n = Number(value);
      if (!Number.isInteger(n)) return bad(`${field.header} should be a whole number, not "${value}"`);
      return n < (field.min ?? 0) || n > (field.max ?? Number.MAX_SAFE_INTEGER)
        ? bad(`${field.header} ${value} is not between ${field.min} and ${field.max}`)
        : ok(n);
    }

    case 'decimal': {
      const n = Number(value);
      if (!Number.isFinite(n)) return bad(`${field.header} should be a number, not "${value}"`);
      return n < (field.min ?? 0) || n > (field.max ?? Number.MAX_SAFE_INTEGER)
        ? bad(`${field.header} ${value} is not between ${field.min} and ${field.max}`)
        : ok(n);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* What a college vouches for                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The facts a college vouches for, which a verified student may not move.
 *
 * Derived, not written out. It used to be a hand-kept list, and six fields
 * were added to eligibility over the life of the product without any of them
 * reaching it - so a verified student could set their live backlogs to zero
 * and walk into roles that asked for none.
 */
export const LOCKED_FIELDS = STUDENT_FIELDS.filter((f) => f.lockOnVerify);

/** The locked ones that are numbers, compared numerically. */
export const LOCKED_NUMBER_KEYS = LOCKED_FIELDS.filter(
  (f) => f.type === 'int' || f.type === 'decimal',
).map((f) => f.key);

/**
 * The locked ones that are names.
 *
 * Kept apart because they compare differently: case and spacing as the roster
 * happened to have them are not a change anybody made, and filling in a blank
 * is not a change either - what was never recorded was never verified.
 */
export const LOCKED_TEXT_KEYS = LOCKED_FIELDS.filter(
  (f) => f.type === 'text' || f.type === 'list',
).map((f) => f.key);

/** Everything a role's eligibility reads, for the test that keeps the two in step. */
export const ELIGIBILITY_FIELDS = STUDENT_FIELDS.filter((f) => f.readsEligibility);
