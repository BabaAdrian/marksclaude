export const STORAGE_KEY = "tvet-marks-data";

export type GradeBand = { id: string; min: number; max: number; point: number; label: string };
export type ClassRec = {
  id: string;
  programme: string;
  moduleLabel: string;
  teacherGroup: string;
  /** Academic period, e.g. "MAY/AUG 2026" */
  period?: string;
};
export type UnitRec = {
  id: string;
  classId: string;
  name: string;
  maxC1: number;
  maxC2: number;
  maxA: number;
  maxE: number;
  /** True when this unit is shared/taught across several courses (e.g. Communication
   *  Skills), rather than belonging to just the one course it's listed under. Lets
   *  teachers enter marks for it from any student record without picking that class. */
  isCommon?: boolean;
};
export type StudentRec = { id: string; classId: string; admNo: string; name: string };
export type Mark = { c1?: number | ""; c2?: number | ""; a?: number | ""; e?: number | ""; by?: string; at?: string };
export type StaffRole = "hod" | "teacher";
export type Teacher = {
  id: string;
  name: string;
  username: string;
  /** Whether an admin has set a password for this account yet — the password itself
   *  (or its hash) is never sent to the client. See setTeacherPassword in data.server.ts. */
  hasPassword: boolean;
  classIds: string[];
  role?: StaffRole;
  department?: string;
};
export type Institution = {
  name: string;
  campus: string;
  department: string;
  address: string;
  contact: string;
  term: string;
  year: string;
};

export type AppData = {
  classes: ClassRec[];
  units: UnitRec[];
  students: StudentRec[];
  marks: Record<string, Record<string, Mark>>;
  mocks: Record<string, Record<string, { score: number | ""; by?: string; at?: string }>>;
  gradeScale: GradeBand[];
  teachers: Teacher[];
  institution: Institution;
};

export type Session = { name: string; role: "admin" | "hod" | "teacher"; teacherId?: string };

/**
 * Combines this browser's edit with the latest server state, so a save here can never
 * silently discard a change someone else made to a different part of the data.
 *
 * `baseline` is the last state this browser and the server agreed on; `edited` is this
 * browser's local state after whatever the person just did; `serverFresh` is what the
 * server has right now (which may already include other people's changes made since
 * `baseline`). The result is `serverFresh`, with only the specific things that actually
 * differ between `baseline` and `edited` layered on top — id by id for record lists,
 * field by field for the institution details, and cell by cell for marks/mocks — so an
 * edit to one class, one mark, or one institution field never touches anything else.
 */
export function mergeAppData(baseline: AppData, edited: AppData, serverFresh: AppData): AppData {
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r] as const));

  function mergeList<T extends { id: string }>(baseArr: T[], editArr: T[], freshArr: T[]): T[] {
    const base = byId(baseArr);
    const edit = byId(editArr);
    const fresh = byId(freshArr);
    const merged = new Map(fresh);
    // Anything this browser deleted (present in baseline, gone from edited) — delete
    // from the merged result too, unless someone else already deleted it independently.
    for (const id of base.keys()) if (!edit.has(id)) merged.delete(id);
    // Anything this browser added or changed (reference differs from baseline, or is
    // brand new) — apply that version on top of whatever the server currently has.
    for (const [id, row] of edit) if (base.get(id) !== row) merged.set(id, row);
    return Array.from(merged.values());
  }

  function mergeNested<V>(
    baseMap: Record<string, Record<string, V>>,
    editMap: Record<string, Record<string, V>>,
    freshMap: Record<string, Record<string, V>>,
  ): Record<string, Record<string, V>> {
    const merged: Record<string, Record<string, V>> = {};
    for (const [k1, freshInner] of Object.entries(freshMap)) merged[k1] = { ...freshInner };
    const outerKeys = new Set([...Object.keys(baseMap), ...Object.keys(editMap)]);
    for (const k1 of outerKeys) {
      const baseInner = baseMap[k1] ?? {};
      const editInner = editMap[k1] ?? {};
      const innerKeys = new Set([...Object.keys(baseInner), ...Object.keys(editInner)]);
      for (const k2 of innerKeys) {
        const wasPresent = k2 in baseInner;
        const isPresent = k2 in editInner;
        if (wasPresent && !isPresent) {
          delete merged[k1]?.[k2]; // locally cleared
        } else if (isPresent && baseInner[k2] !== editInner[k2]) {
          merged[k1] ??= {};
          merged[k1]![k2] = editInner[k2]!; // locally added or changed
        }
      }
      if (merged[k1] && Object.keys(merged[k1]).length === 0) delete merged[k1];
    }
    return merged;
  }

  const institution = { ...serverFresh.institution };
  for (const k of Object.keys(edited.institution) as (keyof Institution)[]) {
    if (baseline.institution[k] !== edited.institution[k]) institution[k] = edited.institution[k];
  }

  return {
    classes: mergeList(baseline.classes, edited.classes, serverFresh.classes),
    units: mergeList(baseline.units, edited.units, serverFresh.units),
    students: mergeList(baseline.students, edited.students, serverFresh.students),
    teachers: mergeList(baseline.teachers, edited.teachers, serverFresh.teachers),
    gradeScale: mergeList(baseline.gradeScale, edited.gradeScale, serverFresh.gradeScale),
    marks: mergeNested(baseline.marks, edited.marks, serverFresh.marks),
    mocks: mergeNested(baseline.mocks, edited.mocks, serverFresh.mocks),
    institution,
  };
}

// AIRADS grading key, as printed on the transcript / progress report.
export const DEFAULT_GRADE_SCALE: GradeBand[] = [
  { id: "g1", min: 90, max: 100, point: 1, label: "Distinction" },
  { id: "g2", min: 80, max: 89, point: 2, label: "Distinction" },
  { id: "g3", min: 70, max: 79, point: 3, label: "Credit" },
  { id: "g4", min: 60, max: 69, point: 4, label: "Credit" },
  { id: "g5", min: 50, max: 59, point: 5, label: "Pass" },
  { id: "g6", min: 40, max: 49, point: 6, label: "Pass" },
  { id: "g7", min: 30, max: 39, point: 7, label: "Referred" },
  { id: "g8", min: 0, max: 29, point: 8, label: "Fail" },
];

export const DEFAULT_INSTITUTION: Institution = {
  name: "African Institute of Research and Development Studies",
  campus: "Eldoret Town Campus",
  department: "BUSINESS AND TECHNOLOGY",
  address: "Institute Plaza, Oloo Street, P.O. Box 3790-402, Eldoret",
  contact: "Tel: 0715696979  ·  Email: airadseldoret@gmail.com  ·  www.africaninstitutekenya.com",
  term: "Term One",
  year: String(new Date().getFullYear()),
};

export const uid = () => Math.random().toString(36).slice(2, 10);

// Total = ((CAT1 + CAT2 + Assignment) / 3) + End Term
export function totalFor(m: Mark | undefined): number {
  if (!m) return 0;
  const c1 = Number(m.c1) || 0;
  const c2 = Number(m.c2) || 0;
  const a = Number(m.a) || 0;
  const e = Number(m.e) || 0;
  return Math.round(((c1 + c2 + a) / 3 + e) * 10) / 10;
}

export function gradeFor(score: unknown, scale: GradeBand[]): GradeBand | null {
  if (score === "" || score === null || score === undefined || isNaN(Number(score))) return null;
  const s = Number(score);
  return scale.find((g) => s >= g.min && s <= g.max) ?? null;
}

export const ADMIN_USER = "admin";
export const DEFAULT_ADMIN_PASS = "admin123";

/** Classes a staff member may work with: HODs see their department's classes plus assignments. */
export function classesFor(data: AppData, staff: Teacher | undefined): ClassRec[] {
  if (!staff) return [];
  if (staff.role === "hod") {
    return data.classes.filter(
      (c) => staff.classIds.includes(c.id) || (!!staff.department && c.teacherGroup === staff.department),
    );
  }
  return data.classes.filter((c) => staff.classIds.includes(c.id));
}

/** Short audit label for whoever is entering marks, e.g. "admin" or "jdoe (HOD)". */
export function actorLabel(data: AppData, session: Session): string {
  if (session.role === "admin") return "admin";
  const t = data.teachers.find((x) => x.id === session.teacherId);
  const uname = t?.username ?? session.name;
  return session.role === "hod" ? `${uname} (HOD)` : uname;
}
