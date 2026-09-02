  import { jsPDF } from "jspdf";
  import autoTable from "jspdf-autotable";
  import logoUrl from "@/assets/airads-logo.png";

import {
  gradeFor,
  totalFor,
  type AppData,
  type ClassRec,
  type StudentRec,
  type UnitRec,
} from "./marks";

const RED: [number, number, number] = [166, 22, 38];
const BLUE: [number, number, number] = [17, 45, 92];
const BLACK: [number, number, number] = [0, 0, 0];

const GRADE_KEY_LEFT = ["100 - 90  -  1  Distinction", "89 - 80  -  2  Distinction", "79 - 70  -  3  Credit", "69 - 60  -  4  Credit"];
const GRADE_KEY_RIGHT = ["59 - 50  -  5  Pass", "49 - 40  -  6  Pass", "39 - 30  -  7  Referred", "29 - 0   -  8  Fail"];

let logoCache: string | null = null;
let logoAttempted = false;
async function getLogo(): Promise<string | null> {
  if (logoCache) return logoCache;
  if (logoAttempted) return null; // already failed once this session, don't retry every export
  logoAttempted = true;
  try {
    const res = await fetch(logoUrl);
    const contentType = res.headers.get("content-type") ?? "";
    // The logo path may not resolve outside the environment it was uploaded in
    // (e.g. a dev/preview-only asset host). Treat anything that isn't actually
    // image data as "no logo" instead of feeding garbage into jsPDF.
    if (!res.ok || !contentType.startsWith("image/")) return null;
    const blob = await res.blob();
    logoCache = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    return logoCache;
  } catch {
    return null;
  }
}

function header(doc: jsPDF, data: AppData, title: string, logo: string | null) {
  const inst = data.institution;
  const W = doc.internal.pageSize.getWidth();

  // Large crest, as on the original letterhead.
  if (logo) doc.addImage(logo, "PNG", 15, 10, 34, 34);

  doc.setTextColor(...BLUE).setFont("helvetica", "bold").setFontSize(11.5);
  doc.text(inst.name.toUpperCase(), W / 2 + 12, 19, { align: "center" });
  doc.setTextColor(...RED).setFont("helvetica", "bold").setFontSize(11);
  doc.text(inst.campus.toUpperCase(), W / 2 + 12, 26, { align: "center" });
  doc.setTextColor(...BLACK).setFont("helvetica", "normal").setFontSize(7.5);
  doc.text(inst.address, W / 2 + 12, 33, { align: "center" });
  doc.text(inst.contact, W / 2 + 12, 37.5, { align: "center" });

  doc.setDrawColor(...RED).setLineWidth(1).line(15, 46, W - 15, 46);
  doc.setDrawColor(...BLUE).setLineWidth(0.4).line(15, 47.6, W - 15, 47.6);

  doc.setTextColor(...RED).setFont("helvetica", "bold").setFontSize(13);
  doc.text(title, W / 2, 56, { align: "center" });
  const tw = doc.getTextWidth(title);
  doc.setLineWidth(0.4).line(W / 2 - tw / 2, 57.8, W / 2 + tw / 2, 57.8);
  doc.setTextColor(...BLACK);
}

function metaBlock(doc: jsPDF, rows: [string, string][][], startY: number) {
  const W = doc.internal.pageSize.getWidth();
  let y = startY;
  doc.setFontSize(9.5);
  rows.forEach((line) => {
    let x = 15;
    const colW = (W - 30) / line.length;
    line.forEach(([label, value]) => {
      if (!label) return;
      doc.setTextColor(...BLUE).setFont("helvetica", "bold").text(`${label}:`, x, y);
      const lw = doc.getTextWidth(`${label}: `);
      doc.setTextColor(...BLACK).setFont("helvetica", "normal").text(value || "-", x + lw, y);
      x += colW;
    });
    y += 6;
  });
  doc.setTextColor(...BLACK);
  return y + 1;
}

/**
 * Overall result from the per-unit grade labels.
 * `labels` holds one entry per unit; null means that unit has no marks recorded.
 * Rules, in priority order:
 *  1. any unit without marks           -> COURSE REQUIREMENT NOT MET
 *  2. more than 2 units failed/referred -> FAIL
 *  3. any unit referred                 -> REFERRED
 *  4. any unit failed                   -> FAIL
 *  5. otherwise the mean grade label.
 */
export function overallResult(labels: (string | null)[], meanLabel: string | null): string {
  if (labels.length === 0) return "COURSE REQUIREMENT NOT MET";
  if (labels.some((l) => l === null)) return "COURSE REQUIREMENT NOT MET";
  const norm = labels.map((l) => (l ?? "").toUpperCase());
  const referred = norm.filter((l) => l === "REFERRED").length;
  const failed = norm.filter((l) => l === "FAIL").length;
  if (referred + failed > 2) return "FAIL";
  if (referred > 0) return "REFERRED";
  if (failed > 0) return "FAIL";
  return (meanLabel ?? "-").toUpperCase();
}

function summaryLine(doc: jsPDF, y: number, parts: [string, string][]) {
  let x = 15;
  doc.setFontSize(9.5);
  parts.forEach(([label, value]) => {
    doc.setTextColor(...BLUE).setFont("helvetica", "bold").text(`${label}:`, x, y);
    const lw = doc.getTextWidth(`${label}: `);
    doc.setTextColor(...RED).setFont("helvetica", "bold").text(value, x + lw, y);
    x += lw + doc.getTextWidth(value) + 10;
  });
  doc.setTextColor(...BLACK);
}

function footer(doc: jsPDF, y: number, stampNote: string) {
  const W = doc.internal.pageSize.getWidth();
  doc.setTextColor(...RED).setFont("helvetica", "bold").setFontSize(9.5);
  doc.text("KEY TO GRADING SYSTEM", 15, y);
  doc.setTextColor(...BLACK).setFont("helvetica", "normal").setFontSize(9);
  GRADE_KEY_LEFT.forEach((l, i) => doc.text(l, 15, y + 6 + i * 5));
  GRADE_KEY_RIGHT.forEach((l, i) => doc.text(l, W / 2, y + 6 + i * 5));
  let yy = y + 6 + 4 * 5 + 2;
  doc.setFontSize(8.5).text("* Pass after supplementary", 15, yy);
  yy += 18;
  doc.setDrawColor(...BLACK).setLineWidth(0.3);
  doc.line(15, yy, 80, yy);
  doc.line(W - 80, yy, W - 15, yy);
  doc.setTextColor(...BLUE).setFont("helvetica", "bold").setFontSize(9);
  doc.text("Principal", 15, yy + 5);
  doc.text("Registrar", W - 80, yy + 5);
  doc.setTextColor(...BLACK).setFont("helvetica", "italic").setFontSize(8.5);
  doc.text(stampNote, W / 2, yy + 14, { align: "center" });
  doc.setTextColor(...RED).setFont("helvetica", "bolditalic").setFontSize(9);
  doc.text("'Where Quality is Nurtured'", W / 2, yy + 20, { align: "center" });
  doc.setTextColor(...BLUE).setFont("helvetica", "bold").setFontSize(8.5);
  doc.text("TRAINING          RESEARCH          DEVELOPMENT", W / 2, yy + 26, { align: "center" });
  doc.setTextColor(...BLACK);
}

function tableEnd(doc: jsPDF): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((doc as any).lastAutoTable?.finalY ?? 70) + 8;
}

const TABLE_STYLE = {
  theme: "grid" as const,
  headStyles: { fillColor: BLUE, textColor: 255, fontSize: 8, halign: "center" as const, fontStyle: "bold" as const },
  bodyStyles: { fontSize: 8.5, textColor: BLACK },
  alternateRowStyles: { fillColor: [245, 247, 251] as [number, number, number] },
  styles: { lineColor: BLUE, lineWidth: 0.2, cellPadding: 1.8 },
  margin: { left: 15, right: 15 },
};

function classLine(cls: ClassRec) {
  const bits = [cls.moduleLabel, cls.period].filter(Boolean);
  return bits.length ? bits.join(" · ") : "-";
}

/** Mock exams -> ACADEMIC TRANSCRIPT (one page per student) */
export async function buildTranscripts(data: AppData, cls: ClassRec, students: StudentRec[], units: UnitRec[]) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const logo = await getLogo();

  students.forEach((s, idx) => {
    if (idx > 0) doc.addPage();
    header(doc, data, "ACADEMIC TRANSCRIPT", logo);
    const y = metaBlock(
      doc,
      [
        [["Name", s.name.toUpperCase()], ["Admn No", s.admNo]],
        [["Department", data.institution.department], ["Course", cls.programme.toUpperCase()]],
        [["Class", classLine(cls)], ["Term", data.institution.term]],
        [["Period", cls.period || `${data.institution.term} ${data.institution.year}`], ["Year", data.institution.year]],
      ],
      66,
    );

    let total = 0;
    let counted = 0;
    const labels: (string | null)[] = [];
    const body = units.map((u, i) => {
      const raw = data.mocks[u.id]?.[s.id]?.score;
      const has = raw !== "" && raw !== undefined && raw !== null;
      const g = has ? gradeFor(raw, data.gradeScale) : null;
      if (has) {
        total += Number(raw);
        counted += 1;
      }
      labels.push(g ? g.label : null);
      return [
        String(i + 1),
        u.name.toUpperCase(),
        has ? String(raw) : "-",
        g ? String(g.point) : "-",
        g ? g.label.toUpperCase() : "-",
      ];
    });

    autoTable(doc, {
      ...TABLE_STYLE,
      startY: y,
      head: [["NO.", "SUBJECT DESCRIPTION", "TOTAL EXAM MARKS", "EXAM GRADE POINTS", "FINAL GRADE"]],
      body,
      columnStyles: {
        0: { cellWidth: 12, halign: "center" },
        2: { cellWidth: 30, halign: "center" },
        3: { cellWidth: 30, halign: "center" },
        4: { cellWidth: 32, halign: "center", textColor: RED, fontStyle: "bold" },
      },
    });

    const mean = counted ? Math.round(total / counted) : 0;
    const mg = counted ? gradeFor(mean, data.gradeScale) : null;
    let yy = tableEnd(doc);
    summaryLine(doc, yy, [
      ["Total subjects", String(units.length)],
      ["Total marks", String(total)],
      ["Out of", String(units.length * 100)],
    ]);
    yy += 6;
    summaryLine(doc, yy, [
      ["Mean Grade", mg ? mg.label.toUpperCase() : "-"],
      ["Overall Result", overallResult(labels, mg ? mg.label : null)],
    ]);
    footer(doc, yy + 10, "This transcript is not valid without the principal's rubber stamp");
  });
  return doc;
}

/** Coursework -> STUDENT ACADEMIC PROGRESS REPORT (one page per student) */
export async function buildProgressReports(data: AppData, cls: ClassRec, students: StudentRec[], units: UnitRec[]) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const logo = await getLogo();
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  students.forEach((s, idx) => {
    if (idx > 0) doc.addPage();
    header(doc, data, "STUDENT ACADEMIC PROGRESS REPORT", logo);
    const y = metaBlock(
      doc,
      [
        [["NAME", s.name.toUpperCase()], ["ADM NO", s.admNo]],
        [["DEPARTMENT", data.institution.department], ["DATE", today.toUpperCase()]],
        [["COURSE", cls.programme.toUpperCase()], ["", ""]],
        [["CLASS/INTAKE", classLine(cls)], ["PERIOD", cls.period || `${data.institution.term} ${data.institution.year}`]],
      ],
      66,
    );

    let total = 0;
    let counted = 0;
    const labels: (string | null)[] = [];
    const body = units.map((u, i) => {
      const m = data.marks[u.id]?.[s.id] ?? {};
      const t = totalFor(m);
      const has = [m.c1, m.c2, m.a, m.e].some((v) => v !== "" && v !== undefined && v !== null);
      const g = has ? gradeFor(t, data.gradeScale) : null;
      labels.push(g ? g.label : null);
      if (has) {
        total += t;
        counted += 1;
      }
      const cell = (v: unknown) => (v === "" || v === undefined || v === null ? "" : String(v));
      return [
        String(i + 1),
        u.name.toUpperCase(),
        cell(m.c1),
        cell(m.c2),
        cell(m.a),
        cell(m.e),
        has ? String(t) : "",
        has && g ? String(g.point) : "",
        has && g ? g.label.toUpperCase() : "",
      ];
    });

    autoTable(doc, {
      ...TABLE_STYLE,
      startY: y,
      head: [["NO.", "SUBJECT DESCRIPTION", "CAT I", "CAT II", "ASSIGN.", "END TERM", "EXAM TOTALS", "EXAM GRADE POINTS", "FINAL GRADE"]],
      body,
      columnStyles: {
        0: { cellWidth: 10, halign: "center" },
        2: { cellWidth: 14, halign: "center" },
        3: { cellWidth: 14, halign: "center" },
        4: { cellWidth: 16, halign: "center" },
        5: { cellWidth: 18, halign: "center" },
        6: { cellWidth: 20, halign: "center", fontStyle: "bold" },
        7: { cellWidth: 22, halign: "center" },
        8: { cellWidth: 24, halign: "center", textColor: RED, fontStyle: "bold" },
      },
    });

    const mean = counted ? Math.round(total / counted) : 0;
    const mg = counted ? gradeFor(mean, data.gradeScale) : null;
    let yy = tableEnd(doc);
    summaryLine(doc, yy, [
      ["TOTAL MARKS", String(Math.round(total))],
      ["MEAN SCORE", String(mean)],
      ["POINTS", mg ? String(mg.point) : "-"],
      ["GRADE", mg ? mg.label.toUpperCase() : "-"],
    ]);
    yy += 6;
    summaryLine(doc, yy, [["OVERALL RESULT", overallResult(labels, mg ? mg.label : null)]]);
    footer(doc, yy + 10, "This report is not valid without the institute's official stamp");
  });
  return doc;
}
