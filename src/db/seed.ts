import bcrypt from "bcryptjs";
import { db, schema, ensureSchema } from "./client";
import { SEED_B64 } from "../lib/seed-data";

// Mirrors the shape previously decoded straight into localStorage.
type SeedMark = { c1?: number; c2?: number; a?: number; e?: number };
type SeedData = {
  classes: { id: string; programme: string; moduleLabel: string; teacherGroup: string; period?: string }[];
  units: { id: string; classId: string; name: string; maxC1: number; maxC2: number; maxA: number; maxE: number }[];
  students: { id: string; classId: string; admNo: string; name: string }[];
  marks: Record<string, Record<string, SeedMark>>;
  mocks: Record<string, Record<string, { score: number }>>;
};

export const DEFAULT_ADMIN_PASS = "admin123";
export const DEFAULT_INSTITUTION = {
  institutionName: "African Institute of Research and Development Studies",
  institutionCampus: "Eldoret Town Campus",
  institutionDepartment: "BUSINESS AND TECHNOLOGY",
  institutionAddress: "Institute Plaza, Oloo Street, P.O. Box 3790-402, Eldoret",
  institutionContact: "Tel: 0715696979  ·  Email: airadseldoret@gmail.com  ·  www.africaninstitutekenya.com",
  institutionTerm: "Term One",
  institutionYear: String(new Date().getFullYear()),
};

export const DEFAULT_GRADE_SCALE = [
  { id: "g1", min: 90, max: 100, point: 1, label: "Distinction" },
  { id: "g2", min: 80, max: 89, point: 2, label: "Distinction" },
  { id: "g3", min: 70, max: 79, point: 3, label: "Credit" },
  { id: "g4", min: 60, max: 69, point: 4, label: "Credit" },
  { id: "g5", min: 50, max: 59, point: 5, label: "Pass" },
  { id: "g6", min: 40, max: 49, point: 6, label: "Pass" },
  { id: "g7", min: 30, max: 39, point: 7, label: "Referred" },
  { id: "g8", min: 0, max: 29, point: 8, label: "Fail" },
];

/** The bundled seed data has a handful of duplicate ids (mostly stray header rows like
 *  "ADMISSION NUMBER / STUDENT NAME" that got imported as if they were real students,
 *  see the source workbook). A plain in-memory array tolerated that silently; a real
 *  primary key won't. Keep every row, just make sure ids are unique before insert.
 *
 *  The suffix is deterministic (based on how many times that id has repeated so far),
 *  not random — so if two server instances both run this at the same time on a fresh
 *  database (a real possibility: serverless platforms often fire a few requests in
 *  parallel on first load), they compute the exact same ids and their inserts can
 *  safely de-duplicate against each other instead of creating two different rows for
 *  what was meant to be the same one. */
function dedupeIds<T extends { id: string }>(rows: T[], label: string): T[] {
  const seenCount = new Map<string, number>();
  let renamed = 0;
  const out = rows.map((row) => {
    const n = (seenCount.get(row.id) ?? 0) + 1;
    seenCount.set(row.id, n);
    if (n === 1) return row;
    renamed++;
    return { ...row, id: `${row.id}-dup${n}` };
  });
  if (renamed > 0) console.log(`[db] Note: ${renamed} duplicate ${label} id(s) in the seed data were renamed to stay unique.`);
  return out;
}

function defaultTeachersFor(classes: SeedData["classes"]) {
  const groups = Array.from(new Set(classes.map((c) => c.teacherGroup).filter(Boolean)));
  return groups.map((g, i) => ({
    id: `t-${i}`,
    name: g,
    username: g.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    password: "teacher123",
    role: "teacher" as const,
    department: "",
    classIds: classes.filter((c) => c.teacherGroup === g).map((c) => c.id),
  }));
}

/** Loads the bundled starting dataset into an empty database. Safe to call from more
 *  than one server instance at the same time — every insert uses ON CONFLICT DO
 *  NOTHING, so if two requests both find an empty database and both start seeding at
 *  once (common on serverless platforms, where a single page load can fire several
 *  concurrent requests to a cold-started backend), the second one to reach any given
 *  row just no-ops instead of crashing on a duplicate key. */
export async function seedIfEmpty() {
  await ensureSchema();
  const existing = await db.select({ id: schema.classes.id }).from(schema.classes).limit(1);
  if (existing.length > 0) return;

  console.log("[db] Empty database detected — loading the bundled seed dataset…");
  const seed = JSON.parse(Buffer.from(SEED_B64, "base64").toString("utf-8")) as SeedData;
  const teachers = defaultTeachersFor(seed.classes);

  await db
    .insert(schema.settings)
    .values({ id: 1, ...DEFAULT_INSTITUTION, adminPasswordHash: await bcrypt.hash(DEFAULT_ADMIN_PASS, 10) })
    .onConflictDoNothing();

  await db
    .insert(schema.gradeBands)
    .values(DEFAULT_GRADE_SCALE.map((g, i) => ({ ...g, sortOrder: i })))
    .onConflictDoNothing();

  if (seed.classes.length)
    await db.insert(schema.classes).values(dedupeIds(seed.classes, "class")).onConflictDoNothing();
  if (seed.units.length)
    await db
      .insert(schema.units)
      .values(dedupeIds(seed.units, "unit").map((u) => ({ ...u, isCommon: false })))
      .onConflictDoNothing();
  if (seed.students.length)
    await db.insert(schema.students).values(dedupeIds(seed.students, "student")).onConflictDoNothing();

  for (const t of teachers) {
    await db
      .insert(schema.teachers)
      .values({
        id: t.id,
        name: t.name,
        username: t.username,
        passwordHash: await bcrypt.hash(t.password, 10),
        role: t.role,
        department: t.department,
      })
      .onConflictDoNothing();
    if (t.classIds.length) {
      await db
        .insert(schema.teacherClasses)
        .values(t.classIds.map((classId) => ({ teacherId: t.id, classId })))
        .onConflictDoNothing();
    }
  }

  const markRows: (typeof schema.marks.$inferInsert)[] = [];
  for (const [unitId, byStudent] of Object.entries(seed.marks ?? {})) {
    for (const [studentId, m] of Object.entries(byStudent)) {
      markRows.push({ unitId, studentId, c1: m.c1 ?? null, c2: m.c2 ?? null, a: m.a ?? null, e: m.e ?? null });
    }
  }
  if (markRows.length) await db.insert(schema.marks).values(markRows).onConflictDoNothing();

  const mockRows: (typeof schema.mocks.$inferInsert)[] = [];
  for (const [unitId, byStudent] of Object.entries(seed.mocks ?? {})) {
    for (const [studentId, m] of Object.entries(byStudent)) {
      mockRows.push({ unitId, studentId, score: m.score ?? null });
    }
  }
  if (mockRows.length) await db.insert(schema.mocks).values(mockRows).onConflictDoNothing();

  console.log(
    `[db] Seed complete: ${seed.classes.length} classes, ${seed.units.length} units, ${seed.students.length} students, ${teachers.length} teacher accounts.`,
  );
}

// Allow `bun run db:seed` to invoke this directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  seedIfEmpty()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
