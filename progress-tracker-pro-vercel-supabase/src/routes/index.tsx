import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import MarksApp from "@/components/MarksApp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AIRADS Marks Register — Transcripts & Progress Reports" },
      {
        name: "description",
        content:
          "Record CAT, assignment, end-term and mock marks per class, manage teacher accounts, and print academic transcripts and student progress reports as PDF.",
      },
      { property: "og:title", content: "AIRADS Marks Register" },
      {
        property: "og:description",
        content: "Marks entry, teacher accounts, and PDF transcripts and progress reports for TVET classes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <ClientOnly fallback={<div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">Loading…</div>}>
      <MarksApp />
    </ClientOnly>
  );
}
