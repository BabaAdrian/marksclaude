import bcrypt from "bcryptjs";
import { createServerFn } from "@tanstack/react-start";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { seedIfEmpty } from "@/db/seed";
import type { AppData, Session } from "@/lib/marks";

/** Reads the entire dataset out of the database and reassembles it into the AppData shape
 *  the rest of the app already expects (same shape it used to read out of localStorage).
 *  Passwords never leave the server: teachers get a `hasPassword` flag instead, and the
 *  admin password isn't included at all — see setTeacherPassword / setAdminPassword. */
export const getAppData = createServerFn({ method: "GET" }).handler(async (): Promise<AppData> => {
  await seedIfEmpty();

  const [settingsRow, gradeRows, classRows, unitRows, studentRows, markRows, mockRows, teacherRows, tcRows] =
    await Promise.all([
      db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1).then((r) => r[0]),
      db.select().from(schema.gradeBands).orderBy(asc(schema.gradeBands.sortOrder)),
      db.select().from(schema.classes),
      db.select().from(schema.units),
      db.select().from(schema.students),
      db.select().from(schema.marks),
      db.select().from(schema.mocks),
      db.select().from(schema.teachers),
      db.select().from(schema.teacherClasses),
    ]);

  const classesByTeacher = new Map<string, string[]>();
  for (const row of tcRows) {
    const list = classesByTeacher.get(row.teacherId) ?? [];
    list.push(row.classId);
    classesByTeacher.set(row.teacherId, list);
  }

  const marksOut: AppData["marks"] = {};
  for (const m of markRows) {
    marksOut[m.unitId] ??= {};
    marksOut[m.unitId]![m.studentId] = {
      c1: m.c1 ?? "",
      c2: m.c2 ?? "",
      a: m.a ?? "",
      e: m.e ?? "",
      ...(m.enteredBy ? { by: m.enteredBy } : {}),
      ...(m.enteredAt ? { at: m.enteredAt } : {}),
    };
  }

  const mocksOut: AppData["mocks"] = {};
  for (const m of mockRows) {
    mocksOut[m.unitId] ??= {};
    mocksOut[m.unitId]![m.studentId] = {
      score: m.score ?? "",
      ...(m.enteredBy ? { by: m.enteredBy } : {}),
      ...(m.enteredAt ? { at: m.enteredAt } : {}),
    };
  }

  return {
    classes: classRows.map((c) => ({
      id: c.id,
      programme: c.programme,
      moduleLabel: c.moduleLabel,
      teacherGroup: c.teacherGroup,
      ...(c.period ? { period: c.period } : {}),
    })),
    units: unitRows.map((u) => ({
      id: u.id,
      classId: u.classId,
      name: u.name,
      maxC1: u.maxC1,
      maxC2: u.maxC2,
      maxA: u.maxA,
      maxE: u.maxE,
      isCommon: u.isCommon,
    })),
    students: studentRows.map((s) => ({ id: s.id, classId: s.classId, admNo: s.admNo, name: s.name })),
    marks: marksOut,
    mocks: mocksOut,
    gradeScale: gradeRows.map((g) => ({ id: g.id, min: g.min, max: g.max, point: g.point, label: g.label })),
    teachers: teacherRows.map((t) => ({
      id: t.id,
      name: t.name,
      username: t.username,
      hasPassword: !!t.passwordHash,
      role: t.role,
      department: t.department ?? "",
      classIds: classesByTeacher.get(t.id) ?? [],
    })),
    institution: settingsRow
      ? {
          name: settingsRow.institutionName,
          campus: settingsRow.institutionCampus,
          department: settingsRow.institutionDepartment,
          address: settingsRow.institutionAddress,
          contact: settingsRow.institutionContact,
          term: settingsRow.institutionTerm,
          year: settingsRow.institutionYear,
        }
      : {
          name: "",
          campus: "",
          department: "",
          address: "",
          contact: "",
          term: "",
          year: String(new Date().getFullYear()),
        },
  };
});

/** Full-replace save for everything EXCEPT passwords: the client always sends the
 *  complete next state for classes/units/students/marks/mocks/teacher profile fields
 *  (same pattern the old `persist()` used with localStorage), so this clears and
 *  reloads those tables in one go. Password hashes are preserved by id across the
 *  teachers-table replace — they're never part of this payload, so a plain profile
 *  edit (name, department, class assignments…) can never touch a password. Use
 *  setTeacherPassword / setAdminPassword for that. */
export const saveAppData = createServerFn({ method: "POST" })
  .validator((data: AppData) => data)
  .handler(async ({ data }) => {
    await seedIfEmpty();

    const existingHashes = new Map(
      (await db.select({ id: schema.teachers.id, passwordHash: schema.teachers.passwordHash }).from(schema.teachers)).map(
        (t) => [t.id, t.passwordHash],
      ),
    );

    // Children first (FK order), then parents.
    await db.delete(schema.marks);
    await db.delete(schema.mocks);
    await db.delete(schema.teacherClasses);
    await db.delete(schema.units);
    await db.delete(schema.students);
    await db.delete(schema.teachers);
    await db.delete(schema.classes);
    await db.delete(schema.gradeBands);

    if (data.gradeScale.length) {
      await db.insert(schema.gradeBands).values(data.gradeScale.map((g, i) => ({ ...g, sortOrder: i })));
    }
    if (data.classes.length) {
      await db.insert(schema.classes).values(
        data.classes.map((c) => ({
          id: c.id,
          programme: c.programme,
          moduleLabel: c.moduleLabel,
          teacherGroup: c.teacherGroup,
          period: c.period ?? null,
        })),
      );
    }
    if (data.units.length) {
      await db.insert(schema.units).values(
        data.units.map((u) => ({
          id: u.id,
          classId: u.classId,
          name: u.name,
          maxC1: u.maxC1,
          maxC2: u.maxC2,
          maxA: u.maxA,
          maxE: u.maxE,
          isCommon: u.isCommon ?? false,
        })),
      );
    }
    if (data.students.length) {
      await db.insert(schema.students).values(
        data.students.map((s) => ({ id: s.id, classId: s.classId, admNo: s.admNo, name: s.name })),
      );
    }
    if (data.teachers.length) {
      await db.insert(schema.teachers).values(
        data.teachers.map(
          (t): typeof schema.teachers.$inferInsert => ({
            id: t.id,
            name: t.name,
            username: t.username,
            // Preserve whatever hash already existed for this id — brand-new teacher
            // ids (not yet in existingHashes) start with no password until an admin
            // sets one via setTeacherPassword, and can't sign in until then.
            passwordHash: existingHashes.get(t.id) ?? null,
            role: t.role === "hod" ? "hod" : "teacher",
            department: t.department ?? "",
          }),
        ),
      );
      const tcRows = data.teachers.flatMap((t) => t.classIds.map((classId) => ({ teacherId: t.id, classId })));
      if (tcRows.length) await db.insert(schema.teacherClasses).values(tcRows);
    }

    const markRows: (typeof schema.marks.$inferInsert)[] = [];
    for (const [unitId, byStudent] of Object.entries(data.marks)) {
      for (const [studentId, m] of Object.entries(byStudent)) {
        markRows.push({
          unitId,
          studentId,
          c1: m.c1 === "" || m.c1 == null ? null : Number(m.c1),
          c2: m.c2 === "" || m.c2 == null ? null : Number(m.c2),
          a: m.a === "" || m.a == null ? null : Number(m.a),
          e: m.e === "" || m.e == null ? null : Number(m.e),
          enteredBy: m.by ?? null,
          enteredAt: m.at ?? null,
        });
      }
    }
    if (markRows.length) await db.insert(schema.marks).values(markRows);

    const mockRows: (typeof schema.mocks.$inferInsert)[] = [];
    for (const [unitId, byStudent] of Object.entries(data.mocks)) {
      for (const [studentId, m] of Object.entries(byStudent)) {
        mockRows.push({
          unitId,
          studentId,
          score: m.score === "" || m.score == null ? null : Number(m.score),
          enteredBy: m.by ?? null,
          enteredAt: m.at ?? null,
        });
      }
    }
    if (mockRows.length) await db.insert(schema.mocks).values(mockRows);

    await db
      .update(schema.settings)
      .set({
        institutionName: data.institution.name,
        institutionCampus: data.institution.campus,
        institutionDepartment: data.institution.department,
        institutionAddress: data.institution.address,
        institutionContact: data.institution.contact,
        institutionTerm: data.institution.term,
        institutionYear: data.institution.year,
      })
      .where(eq(schema.settings.id, 1));

    return { ok: true };
  });

/** Server-side login: the client sends only a username/password pair, checked against
 *  a bcrypt hash — no password or hash is ever sent to the browser for this. */
export const authenticateServer = createServerFn({ method: "POST" })
  .validator((data: { username: string; password: string }) => data)
  .handler(async ({ data }): Promise<Session | null> => {
    await seedIfEmpty();
    const u = data.username.trim().toLowerCase();

    if (u === "admin") {
      const settingsRow = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1).then((r) => r[0]);
      if (settingsRow && (await bcrypt.compare(data.password, settingsRow.adminPasswordHash))) {
        return { name: "Administrator", role: "admin" };
      }
      return null;
    }

    const teacher = await db.select().from(schema.teachers).where(eq(schema.teachers.username, u)).limit(1).then((r) => r[0]);
    if (!teacher || !teacher.passwordHash) return null;
    if (!(await bcrypt.compare(data.password, teacher.passwordHash))) return null;
    return { name: teacher.name, role: teacher.role === "hod" ? "hod" : "teacher", teacherId: teacher.id };
  });

/** Sets (or replaces) a teacher's password. Used both right after creating a new
 *  teacher account and for resetting an existing one — the admin/HOD screen never
 *  sees or edits a password value directly, only ever submits a brand-new one. */
export const setTeacherPassword = createServerFn({ method: "POST" })
  .validator((data: { teacherId: string; newPassword: string }) => data)
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (data.newPassword.length < 6) return { ok: false, error: "Password must be at least 6 characters." };
    const hash = await bcrypt.hash(data.newPassword, 10);
    const result = await db
      .update(schema.teachers)
      .set({ passwordHash: hash })
      .where(eq(schema.teachers.id, data.teacherId))
      .returning({ id: schema.teachers.id });
    if (result.length === 0) return { ok: false, error: "That teacher account no longer exists." };
    return { ok: true };
  });

/** Changes the admin password. The current password is verified server-side against
 *  the stored hash — the client never has anything to compare it to itself. */
export const setAdminPassword = createServerFn({ method: "POST" })
  .validator((data: { currentPassword: string; newPassword: string }) => data)
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const settingsRow = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1).then((r) => r[0]);
    if (!settingsRow || !(await bcrypt.compare(data.currentPassword, settingsRow.adminPasswordHash))) {
      return { ok: false, error: "Current password is incorrect." };
    }
    if (data.newPassword.length < 6) return { ok: false, error: "New password must be at least 6 characters." };
    const hash = await bcrypt.hash(data.newPassword, 10);
    await db.update(schema.settings).set({ adminPasswordHash: hash }).where(eq(schema.settings.id, 1));
    return { ok: true };
  });
