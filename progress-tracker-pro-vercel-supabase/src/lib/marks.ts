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
