import { pgTable, text, real, integer, boolean, primaryKey } from "drizzle-orm/pg-core";

// One row holds the whole institution letterhead + admin password. Kept as a single-row
// table (id fixed to 1) so the rest of the app can keep treating "institution" and
// "adminPassword" as a couple of top-level fields, exactly like the old localStorage
// shape did.
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  institutionName: text("institution_name").notNull(),
  institutionCampus: text("institution_campus").notNull(),
  institutionDepartment: text("institution_department").notNull(),
  institutionAddress: text("institution_address").notNull(),
  institutionContact: text("institution_contact").notNull(),
  institutionTerm: text("institution_term").notNull(),
  institutionYear: text("institution_year").notNull(),
  // bcrypt hash — never sent to the client. See setAdminPassword in data.server.ts.
  adminPasswordHash: text("admin_password_hash").notNull(),
});

export const gradeBands = pgTable("grade_bands", {
  id: text("id").primaryKey(),
  min: real("min").notNull(),
  max: real("max").notNull(),
  point: real("point").notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const classes = pgTable("classes", {
  id: text("id").primaryKey(),
  programme: text("programme").notNull(),
  moduleLabel: text("module_label").notNull(),
  teacherGroup: text("teacher_group").notNull(),
  period: text("period"),
});

export const units = pgTable("units", {
  id: text("id").primaryKey(),
  classId: text("class_id")
    .notNull()
    .references(() => classes.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  maxC1: real("max_c1").notNull().default(0),
  maxC2: real("max_c2").notNull().default(0),
  maxA: real("max_a").notNull().default(0),
  maxE: real("max_e").notNull().default(0),
  // Whether this unit is shared/common across several courses (e.g. Communication
  // Skills taught to many programmes), as opposed to belonging to one course only.
  isCommon: boolean("is_common").notNull().default(false),
});

export const students = pgTable("students", {
  id: text("id").primaryKey(),
  classId: text("class_id")
    .notNull()
    .references(() => classes.id, { onDelete: "cascade" }),
  admNo: text("adm_no").notNull(),
  name: text("name").notNull(),
});

export const marks = pgTable(
  "marks",
  {
    unitId: text("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    c1: real("c1"),
    c2: real("c2"),
    a: real("a"),
    e: real("e"),
    enteredBy: text("entered_by"),
    enteredAt: text("entered_at"),
  },
  (t) => [primaryKey({ columns: [t.unitId, t.studentId] })],
);

export const mocks = pgTable(
  "mocks",
  {
    unitId: text("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    score: real("score"),
    enteredBy: text("entered_by"),
    enteredAt: text("entered_at"),
  },
  (t) => [primaryKey({ columns: [t.unitId, t.studentId] })],
);

export const teachers = pgTable("teachers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  username: text("username").notNull().unique(),
  // bcrypt hash — never sent to the client. Null until an admin sets one (see
  // setTeacherPassword in data.server.ts); a teacher with no hash can't sign in.
  passwordHash: text("password_hash"),
  role: text("role", { enum: ["hod", "teacher"] })
    .notNull()
    .default("teacher"),
  department: text("department"),
});

export const teacherClasses = pgTable(
  "teacher_classes",
  {
    teacherId: text("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "cascade" }),
    classId: text("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.teacherId, t.classId] })],
);
