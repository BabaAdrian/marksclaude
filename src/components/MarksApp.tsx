import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  GraduationCap, Users, ClipboardList, BarChart3, Plus, Trash2,
  Download, LogOut, CheckCircle2, ChevronRight, School, ClipboardCheck,
  AlertCircle, Search, FileText, KeyRound, Building2, Globe2, ShieldCheck, UserSquare2,
} from "lucide-react";
import {
  actorLabel, classesFor, gradeFor, mergeAppData, totalFor, uid,
  type AppData, type ClassRec, type GradeBand, type Session, type StaffRole, type StudentRec, type UnitRec,
} from "@/lib/marks";
import { getAppData, saveAppData, authenticateServer, setTeacherPassword, setAdminPassword } from "@/lib/data.server";
import { buildProgressReports, buildTranscripts } from "@/lib/pdf-reports";

type Persist = (d: AppData) => void;

function classForGrade(label: string) {
  if (label === "Distinction") return "text-emerald-700 bg-emerald-50 border-emerald-200";
  if (label === "Credit") return "text-sky-700 bg-sky-50 border-sky-200";
  if (label === "Pass") return "text-amber-700 bg-amber-50 border-amber-200";
  if (label === "Referred") return "text-orange-700 bg-orange-50 border-orange-200";
  if (label === "Fail") return "text-rose-700 bg-rose-50 border-rose-200";
  return "text-slate-500 bg-slate-50 border-slate-200";
}

function GradePill({ score, scale }: { score: unknown; scale: GradeBand[] }) {
  const g = gradeFor(score, scale);
  const base = "text-[11px] px-1.5 py-0.5";
  if (!g) return <span className={`inline-block rounded border ${base} border-slate-200 text-slate-400`}>—</span>;
  return (
    <span className={`inline-block rounded border font-medium ${base} ${classForGrade(g.label)}`}>
      {g.point} · {g.label}
    </span>
  );
}

function SectionCard({ title, subtitle, children, right }: { title: string; subtitle?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 mb-5">
      <div className="flex items-start justify-between mb-4 gap-3">
        <div>
          <h3 className="font-semibold text-slate-900 text-sm">{title}</h3>
          {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

const inputCls = "rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500";

const classLabel = (c: ClassRec) =>
  `${c.programme} — ${c.moduleLabel}${c.period ? ` · ${c.period}` : ""}`;

export default function MarksApp() {
  const [data, setData] = useState<AppData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [session, setSession] = useState<Session | null>(null);
  const [live, setLive] = useState(false);
  // Tracks when this browser last made a local edit, so the background refresh below
  // never overwrites something the person is actively typing.
  const lastEditRef = useRef(0);
  const savingRef = useRef(false);
  // Saves are debounced and strictly sequential: typing fires setData() instantly for a
  // responsive UI, but the actual network save only goes out ~350ms after typing pauses,
  // and never more than one save is in flight at once. Without this, every keystroke
  // fired its own independent full-table save — on a fast typist those requests could
  // finish out of order over the network, and an earlier keystroke's save landing after
  // a later one's would silently overwrite what was actually typed with a stale value.
  const pendingSaveRef = useRef<AppData | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last state this browser knows the SERVER agrees with (from the initial load, a
  // live-poll refresh, or its own last successful save). Used to figure out exactly
  // which top-level slice of AppData a given edit touched — see runSave below.
  const baselineRef = useRef<AppData | null>(null);

  const reload = useCallback(() => {
    setLoadError(null);
    getAppData()
      .then((fresh) => { baselineRef.current = fresh; setData(fresh); })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : "Could not reach the database."));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const runSave = useCallback(() => {
    const toSave = pendingSaveRef.current;
    if (!toSave) return;
    pendingSaveRef.current = null;
    savingRef.current = true;
    setSaveState("saving");

    const baseline = baselineRef.current ?? toSave;

    // Re-fetch the latest server state and merge only what THIS browser actually
    // changed on top of it (see mergeAppData), rather than saving `toSave` (this
    // browser's possibly-stale full snapshot) wholesale — otherwise an edit here
    // could silently discard something someone else changed elsewhere in the data.
    getAppData()
      .then((fresh) => {
        const merged = mergeAppData(baseline, toSave, fresh);
        return saveAppData({ data: merged }).then(() => merged);
      })
      .then((merged) => {
        baselineRef.current = merged;
        setData(merged);
        setSaveState("saved");
        setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1200);
      })
      .catch(() => setSaveState("error"))
      .finally(() => {
        savingRef.current = false;
        // More edits queued up while this save was in flight — send the latest state.
        if (pendingSaveRef.current) runSave();
      });
  }, []);

  const persist = useCallback((next: AppData) => {
    lastEditRef.current = Date.now();
    setData(next); // optimistic — the UI updates immediately, the database catches up
    pendingSaveRef.current = next;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      if (!savingRef.current) runSave();
      // else: the in-flight save's `.finally` above will pick up pendingSaveRef once it finishes.
    }, 350);
  }, [runSave]);

  // Live updates: while signed in, periodically pull the latest data so that changes
  // made by other people (another teacher entering marks, an admin editing a class)
  // show up here without a manual refresh. Skipped whenever this browser edited
  // something in the last few seconds, or has a save in flight, so a background
  // refresh can never overwrite what someone is actively typing.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const poll = () => {
      if (document.hidden || savingRef.current) return;
      if (Date.now() - lastEditRef.current < 3000) return;
      getAppData()
        .then((fresh) => { if (!cancelled) { baselineRef.current = fresh; setData(fresh); setLive(true); } })
        .catch(() => { if (!cancelled) setLive(false); });
    };
    const interval = setInterval(poll, 5000);
    const onVisible = () => { if (!document.hidden) poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [session]);

  if (loadError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-center gap-3 p-6">
        <AlertCircle size={22} className="text-rose-500" />
        <p className="text-sm text-slate-600 max-w-sm">Couldn't reach the database: {loadError}</p>
        <button onClick={reload} className="text-sm font-medium text-indigo-600 hover:text-indigo-800">Try again</button>
      </div>
    );
  }

  if (!data) {
    return <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">Loading…</div>;
  }

  if (!session) return <LoginScreen onEnter={setSession} />;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col">
      <TopBar session={session} onLogout={() => setSession(null)} saveState={saveState} live={live} />
      <div className="flex-1">
        {session.role === "admin" && <AdminDashboard data={data} persist={persist} />}
        {session.role === "hod" && <HodDashboard data={data} persist={persist} session={session} />}
        {session.role === "teacher" && <TeacherDashboard data={data} persist={persist} session={session} />}
      </div>
    </div>
  );
}

function LoginScreen({ onEnter }: { onEnter: (s: Session) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = () => {
    setBusy(true);
    setError("");
    authenticateServer({ data: { username, password } })
      .then((s) => {
        if (!s) {
          setError("Invalid username or password.");
          return;
        }
        onEnter(s);
      })
      .catch(() => setError("Could not reach the server. Please try again."))
      .finally(() => setBusy(false));
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-sm p-8">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center">
            <GraduationCap size={18} className="text-white" />
          </div>
          <span className="font-semibold text-slate-900">Marks Register</span>
        </div>
        <p className="text-sm text-slate-500 mb-6">Sign in with the credentials issued to you.</p>

        <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Username</label>
        <input value={username} onChange={(e) => { setUsername(e.target.value); setError(""); }}
          autoComplete="username" className={`mt-1 mb-4 w-full ${inputCls}`} />

        <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">Password</label>
        <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(""); }}
          autoComplete="current-password" onKeyDown={(e) => e.key === "Enter" && submit()} className={`mt-1 mb-4 w-full ${inputCls}`} />

        {error && <p className="text-xs text-rose-600 mb-3 flex items-center gap-1"><AlertCircle size={13} /> {error}</p>}

        <button onClick={submit} disabled={!username.trim() || !password || busy}
          className="w-full rounded-lg bg-indigo-600 text-white text-sm font-medium py-2.5 disabled:opacity-40 hover:bg-indigo-700 transition flex items-center justify-center gap-1">
          {busy ? "Signing in…" : <>Sign in <ChevronRight size={15} /></>}
        </button>
      </div>
    </div>
  );
}

function TopBar({ session, onLogout, saveState, live }: { session: Session; onLogout: () => void; saveState: string; live: boolean }) {
  return (
    <div className="border-b border-slate-200 bg-white px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-md bg-indigo-600 flex items-center justify-center">
          <GraduationCap size={14} className="text-white" />
        </div>
        <span className="font-semibold text-slate-900 text-sm">Marks Register</span>
        <span className="ml-2 text-[11px] uppercase tracking-wide font-medium text-slate-400 border border-slate-200 rounded px-1.5 py-0.5">
          {session.role === "hod" ? "HOD" : session.role}
        </span>
        {live && (
          <span title="Automatically syncing changes from other users" className="ml-2 flex items-center gap-1 text-[11px] font-medium text-emerald-600">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
          </span>
        )}
      </div>
      <div className="flex items-center gap-4">
        <div className="text-xs text-slate-400 w-20 text-right">
          {saveState === "saving" && "Saving…"}
          {saveState === "saved" && (
            <span className="text-emerald-600 flex items-center gap-1 justify-end"><CheckCircle2 size={12} /> Saved</span>
          )}
          {saveState === "error" && (
            <span className="text-rose-500 flex items-center gap-1 justify-end"><AlertCircle size={12} /> Not saved</span>
          )}
        </div>
        <span className="text-sm text-slate-600">{session.name}</span>
        <button onClick={onLogout} className="text-slate-400 hover:text-slate-700 transition" title="Sign out">
          <LogOut size={16} />
        </button>
      </div>
    </div>
  );
}

function Shell({ tabs, tab, setTab, children }: {
  tabs: { id: string; label: string; icon: typeof Users }[];
  tab: string; setTab: (t: string) => void; children: ReactNode;
}) {
  return (
    <div className="flex">
      <div className="w-52 shrink-0 border-r border-slate-200 bg-white min-h-[640px] py-4">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`w-full flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-left transition ${
              tab === t.id ? "bg-indigo-50 text-indigo-700 border-r-2 border-indigo-600" : "text-slate-500 hover:bg-slate-50"
            }`}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 p-6">{children}</div>
    </div>
  );
}

/* ---------------------------- ADMIN ---------------------------- */

function AdminDashboard({ data, persist }: { data: AppData; persist: Persist }) {
  const [tab, setTab] = useState("classes");
  const tabs = [
    { id: "classes", label: "Classes & Units", icon: School },
    { id: "students", label: "Students", icon: Users },
    { id: "staff", label: "HODs & Teachers", icon: KeyRound },
    { id: "marks", label: "Marks Entry", icon: ClipboardList },
    { id: "institution", label: "Institution", icon: Building2 },
    { id: "security", label: "Admin Password", icon: ShieldCheck },
    { id: "scale", label: "Grade Scale", icon: BarChart3 },
    { id: "reports", label: "Reports & PDFs", icon: FileText },
  ];

  return (
    <Shell tabs={tabs} tab={tab} setTab={setTab}>
      {tab === "classes" && <ClassesUnits data={data} persist={persist} classes={data.classes} />}
      {tab === "students" && <StudentsAdmin data={data} persist={persist} classes={data.classes} />}
      {tab === "staff" && <StaffAdmin data={data} persist={persist} classes={data.classes} allowRoles />}
      {tab === "marks" && <MarksWorkspace data={data} persist={persist} classes={data.classes} session={{ name: "Administrator", role: "admin" }} />}
      {tab === "institution" && <InstitutionAdmin data={data} persist={persist} />}
      {tab === "security" && <AdminSecurity />}
      {tab === "scale" && <GradeScaleAdmin data={data} persist={persist} />}
      {tab === "reports" && <Reports data={data} classes={data.classes} />}
    </Shell>
  );
}

function AdminSecurity() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const change = () => {
    if (next.length < 6) return setMsg("New password must be at least 6 characters.");
    if (next !== confirm) return setMsg("New passwords do not match.");
    setBusy(true);
    setMsg("");
    setAdminPassword({ data: { currentPassword: current, newPassword: next } })
      .then((res) => {
        if (!res.ok) { setMsg(res.error); return; }
        setCurrent(""); setNext(""); setConfirm("");
        setMsg("Admin password updated.");
      })
      .catch(() => setMsg("Could not reach the server. Please try again."))
      .finally(() => setBusy(false));
  };

  return (
    <SectionCard title="Administrator password" subtitle="The admin password is stored as a one-way hash and never displayed anywhere in the app — change it here.">
      <div className="grid grid-cols-3 gap-3 max-w-2xl">
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" className={inputCls} />
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password" className={inputCls} />
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm new password" className={inputCls} />
      </div>
      {msg && <p className="text-xs mt-2 text-slate-600">{msg}</p>}
      <button onClick={change} disabled={busy || !current || !next || !confirm}
        className="mt-3 text-sm font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-40">
        {busy ? "Updating…" : "Update password"}
      </button>
    </SectionCard>
  );
}

/* ---------------------------- HOD ---------------------------- */

function HodDashboard({ data, persist, session }: { data: AppData; persist: Persist; session: Session }) {
  const [tab, setTab] = useState("classes");
  const me = data.teachers.find((t) => t.id === session.teacherId);
  const myClasses = classesFor(data, me);
  const tabs = [
    { id: "classes", label: "Classes & Units", icon: School },
    { id: "teachers", label: "Teachers", icon: KeyRound },
    { id: "students", label: "Students", icon: Users },
    { id: "marks", label: "Marks Entry", icon: ClipboardList },
    { id: "reports", label: "Reports & PDFs", icon: FileText },
  ];

  return (
    <Shell tabs={tabs} tab={tab} setTab={setTab}>
      {tab === "classes" && (
        <ClassesUnits data={data} persist={persist} classes={myClasses} defaultGroup={me?.department ?? me?.name}
          onCreated={(classId) => {
            if (!me) return;
            persist({
              ...data,
              teachers: data.teachers.map((t) => (t.id === me.id ? { ...t, classIds: [...t.classIds, classId] } : t)),
            });
          }} />
      )}
      {tab === "teachers" && <StaffAdmin data={data} persist={persist} classes={myClasses} />}
      {tab === "students" && <StudentsAdmin data={data} persist={persist} classes={myClasses} />}
      {tab === "marks" && <MarksWorkspace data={data} persist={persist} classes={myClasses} session={session} />}
      {tab === "reports" && <Reports data={data} classes={myClasses} />}
    </Shell>
  );
}

/* ---------------------------- STAFF ---------------------------- */

function StaffAdmin({ data, persist, classes, allowRoles = false }: {
  data: AppData; persist: Persist; classes: ClassRec[]; allowRoles?: boolean;
}) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<StaffRole>("teacher");
  const [department, setDepartment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetValue, setResetValue] = useState("");
  const [resetMsg, setResetMsg] = useState<Record<string, string>>({});

  const visible = allowRoles
    ? data.teachers
    : data.teachers.filter((t) => t.role !== "hod" && t.classIds.some((c) => classes.some((x) => x.id === c)));

  const addStaff = () => {
    if (!name.trim() || !username.trim() || password.trim().length < 6) {
      setError(password.trim().length > 0 && password.trim().length < 6 ? "Password must be at least 6 characters." : "");
      return;
    }
    const u = username.trim().toLowerCase();
    if (u === "admin" || data.teachers.some((t) => t.username.toLowerCase() === u)) {
      setError("That username is already taken.");
      return;
    }
    setError("");
    setBusy(true);
    const id = uid();
    const nextData: AppData = {
      ...data,
      teachers: [...data.teachers, {
        id, name: name.trim(), username: u, hasPassword: false,
        role: allowRoles ? role : "teacher", department: department.trim(), classIds: [],
      }],
    };
    // Save the new row and set its password in sequence — setting the password before
    // the row itself has been written would have nothing to attach it to.
    saveAppData({ data: nextData })
      .then(() => setTeacherPassword({ data: { teacherId: id, newPassword: password.trim() } }))
      .then((res) => {
        if (!res.ok) { setError(res.error); persist(nextData); return; }
        persist({ ...nextData, teachers: nextData.teachers.map((t) => (t.id === id ? { ...t, hasPassword: true } : t)) });
      })
      .catch(() => setError("Could not reach the server. Please try again."))
      .finally(() => setBusy(false));
    setName(""); setUsername(""); setPassword(""); setDepartment("");
  };

  const update = (id: string, patch: Partial<AppData["teachers"][number]>) =>
    persist({ ...data, teachers: data.teachers.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

  const toggleClass = (id: string, classId: string) => {
    const t = data.teachers.find((x) => x.id === id);
    if (!t) return;
    const classIds = t.classIds.includes(classId) ? t.classIds.filter((c) => c !== classId) : [...t.classIds, classId];
    update(id, { classIds });
  };

  const submitReset = (teacherId: string) => {
    if (resetValue.length < 6) {
      setResetMsg((m) => ({ ...m, [teacherId]: "Password must be at least 6 characters." }));
      return;
    }
    setTeacherPassword({ data: { teacherId, newPassword: resetValue } })
      .then((res) => {
        if (!res.ok) { setResetMsg((m) => ({ ...m, [teacherId]: res.error })); return; }
        // Reflect the now-set password locally without a full reload.
        persist({ ...data, teachers: data.teachers.map((t) => (t.id === teacherId ? { ...t, hasPassword: true } : t)) });
        setResetId(null); setResetValue("");
        setResetMsg((m) => ({ ...m, [teacherId]: "" }));
      })
      .catch(() => setResetMsg((m) => ({ ...m, [teacherId]: "Could not reach the server." })));
  };

  return (
    <div>
      <SectionCard title={allowRoles ? "Add a HOD or teacher" : "Add a teacher"}
        subtitle="Staff sign in with these credentials. HODs can create classes and teachers in their department.">
        <div className="grid grid-cols-4 gap-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className={inputCls} />
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" className={inputCls} />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (min. 6 characters)" className={inputCls} />
          <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Department / teacher group" className={inputCls} />
        </div>
        {allowRoles && (
          <div className="mt-3 flex gap-2">
            {(["teacher", "hod"] as StaffRole[]).map((r) => (
              <button key={r} onClick={() => setRole(r)}
                className={`text-xs rounded-lg border px-3 py-1.5 font-medium ${
                  role === r ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-500"
                }`}>
                {r === "hod" ? "HOD" : "Teacher"}
              </button>
            ))}
          </div>
        )}
        {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
        <button onClick={addStaff} disabled={busy} className="mt-3 flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-40">
          <Plus size={15} /> Add {allowRoles ? "staff member" : "teacher"}
        </button>
      </SectionCard>

      <SectionCard title="Staff accounts" subtitle={`${visible.length} accounts`}>
        {visible.length === 0 && <p className="text-sm text-slate-400">No accounts yet.</p>}
        <div className="space-y-3">
          {visible.map((t) => (
            <div key={t.id} className="rounded-lg border border-slate-200 p-3">
              <div className="grid grid-cols-5 gap-2 items-center">
                <input value={t.name} onChange={(e) => update(t.id, { name: e.target.value })} className={inputCls} />
                <input value={t.username} onChange={(e) => update(t.id, { username: e.target.value.toLowerCase() })} className={`${inputCls} font-mono`} />
                <div>
                  {resetId === t.id ? (
                    <div className="flex items-center gap-1">
                      <input type="password" value={resetValue} onChange={(e) => setResetValue(e.target.value)}
                        placeholder="New password" autoFocus className={`${inputCls} w-full font-mono`} />
                      <button onClick={() => submitReset(t.id)} className="text-emerald-600 hover:text-emerald-800 text-xs font-medium">Save</button>
                      <button onClick={() => { setResetId(null); setResetValue(""); }} className="text-slate-300 hover:text-slate-600 text-xs">✕</button>
                    </div>
                  ) : (
                    <button onClick={() => { setResetId(t.id); setResetValue(""); }}
                      className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800">
                      <KeyRound size={13} />
                      {t.hasPassword ? "Reset password" : "Set password"}
                    </button>
                  )}
                  {resetMsg[t.id] && <p className="text-[11px] text-rose-500 mt-1">{resetMsg[t.id]}</p>}
                  {!t.hasPassword && resetId !== t.id && <p className="text-[11px] text-amber-600 mt-1">No password set — can't sign in yet</p>}
                </div>
                <select value={t.role ?? "teacher"} disabled={!allowRoles}
                  onChange={(e) => update(t.id, { role: e.target.value as StaffRole })}
                  className={`${inputCls} disabled:bg-slate-50 disabled:text-slate-400`}>
                  <option value="teacher">Teacher</option>
                  <option value="hod">HOD</option>
                </select>
                <div className="text-right">
                  <button onClick={() => persist({ ...data, teachers: data.teachers.filter((x) => x.id !== t.id) })}
                    className="text-slate-300 hover:text-rose-500"><Trash2 size={15} /></button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                {classes.map((c) => (
                  <button key={c.id} onClick={() => toggleClass(t.id, c.id)}
                    className={`text-[11px] rounded border px-2 py-1 transition ${
                      t.classIds.includes(c.id) ? "border-indigo-400 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-400 hover:border-slate-300"
                    }`}>
                    {classLabel(c)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

function InstitutionAdmin({ data, persist }: { data: AppData; persist: Persist }) {
  const set = (k: keyof AppData["institution"], v: string) =>
    persist({ ...data, institution: { ...data.institution, [k]: v } });
  const fields: [keyof AppData["institution"], string][] = [
    ["name", "Institution name"], ["campus", "Campus"], ["department", "Department"],
    ["address", "Address line"], ["contact", "Contact line"], ["term", "Term"], ["year", "Year"],
  ];
  return (
    <SectionCard title="Institution details" subtitle="Printed on the transcript and progress report headers.">
      <div className="grid grid-cols-2 gap-3">
        {fields.map(([k, label]) => (
          <div key={k}>
            <label className="text-[10px] text-slate-400 uppercase tracking-wide">{label}</label>
            <input value={data.institution[k]} onChange={(e) => set(k, e.target.value)} className={`mt-0.5 w-full ${inputCls}`} />
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function ClassesUnits({ data, persist, classes, defaultGroup, onCreated }: {
  data: AppData; persist: Persist; classes: ClassRec[]; defaultGroup?: string | undefined; onCreated?: ((id: string) => void) | undefined;
}) {
  const [programme, setProgramme] = useState("");
  const [moduleLabel, setModuleLabel] = useState("");
  const [period, setPeriod] = useState("");
  const [teacherGroup, setTeacherGroup] = useState(defaultGroup ?? "");
  const [activeClass, setActiveClass] = useState<string | null>(null);

  const addClass = () => {
    if (!programme.trim()) return;
    const id = uid();
    const cls: ClassRec = {
      id,
      programme: programme.trim(),
      moduleLabel: moduleLabel.trim() || "Non-modular",
      period: period.trim().toUpperCase(),
      teacherGroup: teacherGroup.trim(),
    };
    persist({ ...data, classes: [...data.classes, cls] });
    onCreated?.(id);
    setProgramme(""); setModuleLabel(""); setPeriod("");
  };

  const removeClass = (id: string) => {
    persist({
      ...data,
      classes: data.classes.filter((c) => c.id !== id),
      units: data.units.filter((u) => u.classId !== id),
      students: data.students.filter((s) => s.classId !== id),
    });
    if (activeClass === id) setActiveClass(null);
  };

  return (
    <div>
      <SectionCard title="Add a class" subtitle="Every class carries its academic period, e.g. MAY/AUG 2026.">
        <div className="grid grid-cols-4 gap-3">
          <input value={programme} onChange={(e) => setProgramme(e.target.value)} placeholder="Programme (e.g. Diploma in ICT)" className={inputCls} />
          <input value={moduleLabel} onChange={(e) => setModuleLabel(e.target.value)} placeholder="Module (e.g. Module One)" className={inputCls} />
          <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="Period (e.g. MAY/AUG 2026)" className={inputCls} />
          <input value={teacherGroup} onChange={(e) => setTeacherGroup(e.target.value)} placeholder="Department / group" className={inputCls} />
        </div>
        <button onClick={addClass} className="mt-3 flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-800">
          <Plus size={15} /> Add class
        </button>
      </SectionCard>

      <div className="grid grid-cols-2 gap-5">
        <SectionCard title="Classes" subtitle={`${classes.length} classes`}>
          {classes.length === 0 && <p className="text-sm text-slate-400">No classes yet.</p>}
          <div className="space-y-1.5 max-h-[420px] overflow-y-auto">
            {classes.map((c) => (
              <div key={c.id} onClick={() => setActiveClass(c.id)}
                className={`flex items-center justify-between rounded-lg border px-3 py-2 cursor-pointer transition ${
                  activeClass === c.id ? "border-indigo-400 bg-indigo-50" : "border-slate-200 hover:border-slate-300"
                }`}>
                <div>
                  <div className="text-sm font-medium text-slate-800">{c.programme}</div>
                  <div className="text-xs text-slate-400">
                    {c.moduleLabel}
                    {c.period && <span className="ml-1 text-indigo-500 font-medium">· {c.period}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input value={c.period ?? ""} placeholder="Period"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => persist({ ...data, classes: data.classes.map((x) => (x.id === c.id ? { ...x, period: e.target.value.toUpperCase() } : x)) })}
                    className="w-32 rounded border border-slate-200 px-2 py-1 text-xs" />
                  <button onClick={(e) => { e.stopPropagation(); removeClass(c.id); }} className="text-slate-300 hover:text-rose-500">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Units for selected class" subtitle={activeClass ? "Configure per-component max marks" : "Select a class on the left"}>
          {activeClass ? <UnitsForClass classId={activeClass} data={data} persist={persist} /> : <p className="text-sm text-slate-400">—</p>}
        </SectionCard>
      </div>
    </div>
  );
}

function UnitsForClass({ classId, data, persist }: { classId: string; data: AppData; persist: Persist }) {
  const [name, setName] = useState("");
  const [maxC1, setMaxC1] = useState("30");
  const [maxC2, setMaxC2] = useState("30");
  const [maxA, setMaxA] = useState("30");
  const [maxE, setMaxE] = useState("70");
  const [isCommon, setIsCommon] = useState(false);

  const units = data.units.filter((u) => u.classId === classId);

  const addUnit = () => {
    if (!name.trim()) return;
    const unit: UnitRec = {
      id: uid(), classId, name: name.trim(),
      maxC1: Number(maxC1) || 0, maxC2: Number(maxC2) || 0, maxA: Number(maxA) || 0, maxE: Number(maxE) || 0,
      isCommon,
    };
    persist({ ...data, units: [...data.units, unit] });
    setName(""); setIsCommon(false);
  };

  const removeUnit = (id: string) => {
    const marks = { ...data.marks }; delete marks[id];
    const mocks = { ...data.mocks }; delete mocks[id];
    persist({ ...data, units: data.units.filter((u) => u.id !== id), marks, mocks });
  };

  const toggleCommon = (id: string) =>
    persist({ ...data, units: data.units.map((u) => (u.id === id ? { ...u, isCommon: !u.isCommon } : u)) });

  return (
    <div>
      <div className="space-y-2 mb-4">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Unit name" className={`w-full ${inputCls}`} />
        <div className="grid grid-cols-4 gap-2">
          {([["C1 max", maxC1, setMaxC1], ["C2 max", maxC2, setMaxC2], ["Assign. max", maxA, setMaxA], ["End Term max", maxE, setMaxE]] as const).map(([lbl, val, set]) => (
            <div key={lbl}>
              <label className="text-[10px] text-slate-400">{lbl}</label>
              <input type="number" value={val} onChange={(e) => set(e.target.value)} className={`w-full ${inputCls} px-2 py-1.5`} />
            </div>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600 select-none">
          <input type="checkbox" checked={isCommon} onChange={(e) => setIsCommon(e.target.checked)}
            className="rounded border-slate-300" />
          Common unit — taught across several courses, not just this one
        </label>
        <button onClick={addUnit} className="flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-800">
          <Plus size={15} /> Add unit
        </button>
      </div>
      <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
        {units.map((u) => (
          <div key={u.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
            <div>
              <div className="text-sm font-medium text-slate-800 flex items-center gap-1.5">
                {u.name}
                {u.isCommon && (
                  <span className="text-[10px] uppercase tracking-wide font-medium text-indigo-600 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5">
                    Common
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-400">C1 /{u.maxC1} · C2 /{u.maxC2} · A /{u.maxA} · E /{u.maxE}</div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-[11px] text-slate-500 select-none">
                <input type="checkbox" checked={!!u.isCommon} onChange={() => toggleCommon(u.id)} className="rounded border-slate-300" />
                Common
              </label>
              <button onClick={() => removeUnit(u.id)} className="text-slate-300 hover:text-rose-500"><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
        {units.length === 0 && <p className="text-sm text-slate-400">No units yet.</p>}
      </div>
    </div>
  );
}

function StudentsAdmin({ data, persist, classes }: { data: AppData; persist: Persist; classes: ClassRec[] }) {
  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [admNo, setAdmNo] = useState("");
  const [sname, setSname] = useState("");
  const [bulk, setBulk] = useState("");

  const students = data.students.filter((s) => s.classId === classId);

  const addStudent = () => {
    if (!admNo.trim() || !sname.trim() || !classId) return;
    persist({ ...data, students: [...data.students, { id: uid(), classId, admNo: admNo.trim(), name: sname.trim() }] });
    setAdmNo(""); setSname("");
  };

  const addBulk = () => {
    if (!bulk.trim() || !classId) return;
    const added: StudentRec[] = bulk.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [a, ...rest] = l.split(",");
      return { id: uid(), classId, admNo: (a ?? "").trim(), name: rest.join(",").trim() };
    }).filter((s) => s.admNo && s.name);
    persist({ ...data, students: [...data.students, ...added] });
    setBulk("");
  };

  return (
    <div>
      <SectionCard title="Select class">
        <select value={classId} onChange={(e) => setClassId(e.target.value)} className={`w-full ${inputCls}`}>
          {classes.length === 0 && <option>No classes available</option>}
          {classes.map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}
        </select>
      </SectionCard>

      <div className="grid grid-cols-2 gap-5">
        <SectionCard title="Add one student">
          <div className="space-y-2">
            <input value={admNo} onChange={(e) => setAdmNo(e.target.value)} placeholder="Admission number" className={`w-full ${inputCls}`} />
            <input value={sname} onChange={(e) => setSname(e.target.value)} placeholder="Full name" className={`w-full ${inputCls}`} />
            <button onClick={addStudent} className="flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-800">
              <Plus size={15} /> Add student
            </button>
          </div>
        </SectionCard>

        <SectionCard title="Bulk add" subtitle="One per line: AdmissionNumber, Full Name">
          <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} rows={4}
            placeholder={"CT/3216/JAN26, EDITH JEROB\nCT/3189/JAN26, CARLTON JESSE"}
            className={`w-full ${inputCls} font-mono`} />
          <button onClick={addBulk} className="mt-2 flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-800">
            <Plus size={15} /> Add all
          </button>
        </SectionCard>
      </div>

      <SectionCard title="Students in this class" subtitle={`${students.length} students`}>
        {students.length === 0 && <p className="text-sm text-slate-400">No students yet.</p>}
        <div className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
          {students.map((s) => (
            <div key={s.id} className="flex items-center justify-between py-2">
              <div className="text-sm"><span className="text-slate-400 mr-2">{s.admNo}</span>{s.name}</div>
              <button onClick={() => persist({ ...data, students: data.students.filter((x) => x.id !== s.id) })}
                className="text-slate-300 hover:text-rose-500"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

function GradeScaleAdmin({ data, persist }: { data: AppData; persist: Persist }) {
  const update = (id: string, field: keyof GradeBand, value: string) => {
    persist({ ...data, gradeScale: data.gradeScale.map((g) => (g.id === id ? { ...g, [field]: field === "label" ? value : Number(value) } : g)) });
  };
  return (
    <SectionCard title="Grade scale" subtitle="Applied to coursework totals, mock scores, and all printed reports.">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-400 uppercase tracking-wide">
            <th className="pb-2">Min</th><th className="pb-2">Max</th><th className="pb-2">Grade point</th><th className="pb-2">Classification</th>
          </tr>
        </thead>
        <tbody>
          {data.gradeScale.map((g) => (
            <tr key={g.id} className="border-t border-slate-100">
              <td className="py-1.5 pr-2"><input type="number" value={g.min} onChange={(e) => update(g.id, "min", e.target.value)} className="w-20 rounded border border-slate-300 px-2 py-1" /></td>
              <td className="py-1.5 pr-2"><input type="number" value={g.max} onChange={(e) => update(g.id, "max", e.target.value)} className="w-20 rounded border border-slate-300 px-2 py-1" /></td>
              <td className="py-1.5 pr-2"><input type="number" value={g.point} onChange={(e) => update(g.id, "point", e.target.value)} className="w-16 rounded border border-slate-300 px-2 py-1" /></td>
              <td className="py-1.5"><input value={g.label} onChange={(e) => update(g.id, "label", e.target.value)} className="w-32 rounded border border-slate-300 px-2 py-1" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionCard>
  );
}

function toCSV(rows: (string | number)[][]) {
  return rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
}
function downloadCSV(filename: string, rows: (string | number)[][]) {
  const blob = new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function Reports({ data, classes }: { data: AppData; classes: ClassRec[] }) {
  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [studentId, setStudentId] = useState("all");
  const [busy, setBusy] = useState(false);
  const [reportError, setReportError] = useState("");

  const cls = classes.find((c) => c.id === classId);
  const units = data.units.filter((u) => u.classId === classId);
  const students = data.students.filter((s) => s.classId === classId);
  const selected = studentId === "all" ? students : students.filter((s) => s.id === studentId);

  const slug = (cls?.programme ?? "class").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

  const exportCoursework = () => {
    const header = ["Adm No", "Name", ...units.flatMap((u) => [`${u.name} C1`, `${u.name} C2`, `${u.name} A`, `${u.name} E`, `${u.name} Total`, `${u.name} Grade`])];
    const rows = students.map((s) => {
      const cells: (string | number)[] = [];
      units.forEach((u) => {
        const m = data.marks[u.id]?.[s.id] ?? {};
        const total = totalFor(m);
        const has = [m.c1, m.c2, m.a, m.e].some((v) => v !== "" && v !== undefined && v !== null);
        const g = has ? gradeFor(total, data.gradeScale) : null;
        cells.push(m.c1 ?? "", m.c2 ?? "", m.a ?? "", m.e ?? "", has ? total : "", g ? `${g.point} ${g.label}` : "");
      });
      return [s.admNo, s.name, ...cells];
    });
    downloadCSV(`coursework-${slug}.csv`, [header, ...rows]);
  };

  const exportMocks = () => {
    const header = ["Adm No", "Name", ...units.flatMap((u) => [`${u.name} Mock`, `${u.name} Grade`])];
    const rows = students.map((s) => {
      const cells: (string | number)[] = [];
      units.forEach((u) => {
        const score = data.mocks[u.id]?.[s.id]?.score ?? "";
        const g = gradeFor(score, data.gradeScale);
        cells.push(score, g ? `${g.point} ${g.label}` : "");
      });
      return [s.admNo, s.name, ...cells];
    });
    downloadCSV(`mocks-${slug}.csv`, [header, ...rows]);
  };

  const run = async (kind: "transcript" | "progress") => {
    if (!cls || selected.length === 0) return;
    setBusy(true);
    setReportError("");
    try {
      const doc = kind === "transcript"
        ? await buildTranscripts(data, cls, selected, units)
        : await buildProgressReports(data, cls, selected, units);
      doc.save(`${kind === "transcript" ? "transcripts" : "progress-reports"}-${slug}.pdf`);
    } catch (err) {
      console.error("PDF report generation failed:", err);
      setReportError(err instanceof Error ? err.message : "Failed to generate the PDF. Check the browser console for details.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SectionCard title="Select class & student" subtitle="Choose “All students” to print the whole class, one page per student.">
        <div className="grid grid-cols-2 gap-3">
          <select value={classId} onChange={(e) => { setClassId(e.target.value); setStudentId("all"); }} className={`w-full ${inputCls}`}>
            {classes.map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}
          </select>
          <select value={studentId} onChange={(e) => setStudentId(e.target.value)} className={`w-full ${inputCls}`}>
            <option value="all">All students ({students.length})</option>
            {students.map((s) => <option key={s.id} value={s.id}>{s.admNo} — {s.name}</option>)}
          </select>
        </div>
      </SectionCard>

      <SectionCard title="PDF reports" subtitle="Mock exams print as Academic Transcripts. Coursework prints as Student Academic Progress Reports.">
        <div className="flex flex-wrap gap-3">
          <button onClick={() => run("transcript")} disabled={busy || !cls || selected.length === 0}
            className="flex items-center gap-1.5 text-sm font-medium bg-indigo-600 text-white rounded-lg px-4 py-2 hover:bg-indigo-700 disabled:opacity-40">
            <FileText size={15} /> Academic Transcript (mocks)
          </button>
          <button onClick={() => run("progress")} disabled={busy || !cls || selected.length === 0}
            className="flex items-center gap-1.5 text-sm font-medium bg-emerald-600 text-white rounded-lg px-4 py-2 hover:bg-emerald-700 disabled:opacity-40">
            <FileText size={15} /> Progress Report (coursework)
          </button>
          <button onClick={exportCoursework} disabled={!classId}
            className="flex items-center gap-1 text-xs font-medium border border-slate-200 rounded-lg px-3 py-2 hover:border-slate-300 disabled:opacity-40">
            <Download size={13} /> Coursework CSV
          </button>
          <button onClick={exportMocks} disabled={!classId}
            className="flex items-center gap-1 text-xs font-medium border border-slate-200 rounded-lg px-3 py-2 hover:border-slate-300 disabled:opacity-40">
            <Download size={13} /> Mocks CSV
          </button>
        </div>
        {busy && <p className="text-xs text-slate-400 mt-2">Generating PDF…</p>}
        {reportError && <p className="text-xs text-red-600 mt-2">{reportError}</p>}
      </SectionCard>

      <SectionCard title="Coursework — CAT1 / CAT2 / Assignment / End Term" subtitle="Mock exams are reported separately below">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400">
                <th className="py-1.5 pr-3">Student</th>
                {units.map((u) => <th key={u.id} className="py-1.5 pr-3">{u.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="py-1.5 pr-3 font-medium text-slate-700">{s.name}</td>
                  {units.map((u) => {
                    const m = data.marks[u.id]?.[s.id];
                    const total = totalFor(m);
                    const has = !!m && [m.c1, m.c2, m.a, m.e].some((v) => v !== "" && v !== undefined && v !== null);
                    return (
                      <td key={u.id} className="py-1.5 pr-3 whitespace-nowrap">
                        <span className="text-slate-600">{has ? total : "—"}</span>{" "}
                        <GradePill score={has ? total : ""} scale={data.gradeScale} />
                      </td>
                    );
                  })}
                </tr>
              ))}
              {students.length === 0 && <tr><td className="py-3 text-slate-400">No students in this class.</td></tr>}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Mock exams" subtitle="Standalone — printed as the academic transcript">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400">
                <th className="py-1.5 pr-3">Student</th>
                {units.map((u) => <th key={u.id} className="py-1.5 pr-3">{u.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="py-1.5 pr-3 font-medium text-slate-700">{s.name}</td>
                  {units.map((u) => {
                    const score = data.mocks[u.id]?.[s.id]?.score;
                    return (
                      <td key={u.id} className="py-1.5 pr-3 whitespace-nowrap">
                        <span className="text-slate-600">{score ?? "—"}</span>{" "}
                        <GradePill score={score} scale={data.gradeScale} />
                      </td>
                    );
                  })}
                </tr>
              ))}
              {students.length === 0 && <tr><td className="py-3 text-slate-400">No students in this class.</td></tr>}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

/* ---------------------------- TEACHER ---------------------------- */

function TeacherDashboard({ data, persist, session }: { data: AppData; persist: Persist; session: Session }) {
  const [tab, setTab] = useState("marks");
  const me = data.teachers.find((t) => t.id === session.teacherId);
  const myClasses = classesFor(data, me);
  const tabs = [
    { id: "marks", label: "Marks Entry", icon: ClipboardList },
    { id: "students", label: "Students", icon: Users },
  ];

  if (myClasses.length === 0) {
    return (
      <div className="p-10 text-center text-sm text-slate-400 flex items-center justify-center gap-2">
        <AlertCircle size={16} /> No classes assigned to your account yet. Ask your HOD or the administrator.
      </div>
    );
  }

  return (
    <Shell tabs={tabs} tab={tab} setTab={setTab}>
      {tab === "marks" && <MarksWorkspace data={data} persist={persist} classes={myClasses} session={session} />}
      {tab === "students" && <StudentsAdmin data={data} persist={persist} classes={myClasses} />}
    </Shell>
  );
}

/** Marks entry: class scope, institute-wide search, or a per-student page across all units. */
function MarksWorkspace({ data, persist, classes, session }: { data: AppData; persist: Persist; classes: ClassRec[]; session: Session }) {
  const [scope, setScope] = useState<"class" | "global">("class");
  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [unitId, setUnitId] = useState("");
  const [mode, setMode] = useState<"coursework" | "mock">("coursework");
  const [query, setQuery] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusCommonOnly, setFocusCommonOnly] = useState(false);
  const [admNoLookup, setAdmNoLookup] = useState("");
  const [admNoMatches, setAdmNoMatches] = useState<StudentRec[] | null>(null);

  /** Jump straight to a student's own record by admission number — no class or unit
   *  needs to be selected first. Useful for entering marks on a common unit for a
   *  student who isn't in the class currently selected above. */
  const lookupByAdmNo = () => {
    const needle = admNoLookup.trim().toLowerCase();
    if (!needle) return;
    const matches = data.students.filter((s) => s.admNo.toLowerCase().includes(needle));
    if (matches.length === 1) {
      setFocusCommonOnly(true);
      setFocusId(matches[0]!.id);
      setAdmNoMatches(null);
      setAdmNoLookup("");
    } else {
      setAdmNoMatches(matches);
    }
  };

  const actor = actorLabel(data, session);
  const unitsForClass = data.units.filter((u) => u.classId === classId);
  useEffect(() => {
    if (unitsForClass.length && !unitsForClass.some((u) => u.id === unitId)) setUnitId(unitsForClass[0]!.id);
    if (!unitsForClass.length) setUnitId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, data.units]);

  const unit = data.units.find((u) => u.id === unitId);
  const classById = useMemo(() => new Map(data.classes.map((c) => [c.id, c])), [data.classes]);

  const students = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = scope === "global"
      ? (q ? data.students : [])
      : data.students.filter((s) => s.classId === classId);
    return pool
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.admNo.toLowerCase().includes(q))
      .slice(0, scope === "global" ? 100 : undefined);
  }, [data.students, scope, classId, query]);

  const setMark = (studentId: string, field: "c1" | "c2" | "a" | "e", value: string, targetUnitId = unitId) => {
    const u = data.units.find((x) => x.id === targetUnitId);
    if (!u) return;
    const num = value === "" ? "" : Math.max(0, Number(value));
    const maxKey = ({ c1: "maxC1", c2: "maxC2", a: "maxA", e: "maxE" } as const)[field];
    if (num !== "" && u[maxKey] && num > u[maxKey]) return;
    const marks = { ...data.marks };
    const unitMarks = { ...(marks[u.id] ?? {}) };
    unitMarks[studentId] = { ...(unitMarks[studentId] ?? {}), [field]: num, by: actor, at: new Date().toISOString() };
    marks[u.id] = unitMarks;
    persist({ ...data, marks });
  };

  const setMock = (studentId: string, value: string, targetUnitId = unitId) => {
    const u = data.units.find((x) => x.id === targetUnitId);
    if (!u) return;
    const num = value === "" ? "" : Math.max(0, Math.min(100, Number(value)));
    const mocks = { ...data.mocks };
    mocks[u.id] = { ...(mocks[u.id] ?? {}), [studentId]: { score: num, by: actor, at: new Date().toISOString() } };
    persist({ ...data, mocks });
  };

  const focusStudent = focusId ? data.students.find((s) => s.id === focusId) : undefined;
  if (focusStudent) {
    return (
      <StudentMarksPage student={focusStudent} data={data} classById={classById}
        setMark={setMark} setMock={setMock} actor={actor} initialCommonOnly={focusCommonOnly}
        onBack={() => { setFocusId(null); setFocusCommonOnly(false); }} />
    );
  }

  return (
    <div>
      <SectionCard
        title="Find a student by admission number"
        subtitle="Opens their record directly, filtered to common units — no need to pick a class first."
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <KeyRound size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-300" />
            <input value={admNoLookup} onChange={(e) => { setAdmNoLookup(e.target.value); setAdmNoMatches(null); }}
              onKeyDown={(e) => e.key === "Enter" && lookupByAdmNo()}
              placeholder="e.g. CT/3216/JAN26" className={`pl-7 min-w-[220px] ${inputCls}`} />
          </div>
          <button onClick={lookupByAdmNo} disabled={!admNoLookup.trim()}
            className="rounded-lg bg-indigo-600 text-white text-sm font-medium px-3 py-2 disabled:opacity-40 hover:bg-indigo-700 transition">
            Find student
          </button>
        </div>
        {admNoMatches && admNoMatches.length === 0 && (
          <p className="text-xs text-rose-500 mt-2 flex items-center gap-1"><AlertCircle size={13} /> No student found with that admission number.</p>
        )}
        {admNoMatches && admNoMatches.length > 1 && (
          <div className="mt-2 space-y-1">
            <p className="text-xs text-slate-500">Multiple matches — pick one:</p>
            {admNoMatches.map((s) => (
              <button key={s.id} onClick={() => { setFocusCommonOnly(true); setFocusId(s.id); setAdmNoMatches(null); setAdmNoLookup(""); }}
                className="block w-full text-left text-xs rounded border border-slate-200 px-2 py-1.5 hover:border-indigo-300 hover:bg-indigo-50">
                <span className="text-slate-400 mr-2">{s.admNo}</span>{s.name}
              </button>
            ))}
          </div>
        )}
      </SectionCard>

      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div>
          <label className="text-[10px] text-slate-400 uppercase tracking-wide">Class (unit owner)</label>
          <select value={classId} onChange={(e) => setClassId(e.target.value)} className={`block mt-0.5 min-w-[240px] ${inputCls}`}>
            {classes.map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-slate-400 uppercase tracking-wide">Unit</label>
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)} className={`block mt-0.5 min-w-[200px] ${inputCls}`}>
            {unitsForClass.map((u) => <option key={u.id} value={u.id}>{u.name}{u.isCommon ? " (Common)" : ""}</option>)}
            {unitsForClass.length === 0 && <option>No units yet</option>}
          </select>
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-300" />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={scope === "global" ? "Search any student, any class…" : "Search student…"}
            className={`pl-7 min-w-[240px] ${inputCls}`} />
        </div>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          <button onClick={() => setScope("class")} className={`px-3 py-2 text-xs font-medium ${scope === "class" ? "bg-slate-800 text-white" : "bg-white text-slate-500"}`}>
            This class
          </button>
          <button onClick={() => setScope("global")} className={`flex items-center gap-1 px-3 py-2 text-xs font-medium border-l border-slate-200 ${scope === "global" ? "bg-slate-800 text-white" : "bg-white text-slate-500"}`}>
            <Globe2 size={13} /> All classes
          </button>
        </div>
        <div className="ml-auto flex rounded-lg border border-slate-200 overflow-hidden">
          <button onClick={() => setMode("coursework")} className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium ${mode === "coursework" ? "bg-indigo-600 text-white" : "bg-white text-slate-500"}`}>
            <ClipboardList size={14} /> CAT / Assignment / End Term
          </button>
          <button onClick={() => setMode("mock")} className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-l border-slate-200 ${mode === "mock" ? "bg-amber-500 text-white" : "bg-white text-slate-500"}`}>
            <ClipboardCheck size={14} /> Mock exam
          </button>
        </div>
      </div>

      <p className="text-xs text-slate-500 mb-3 flex items-center gap-1.5">
        <UserSquare2 size={13} className="text-indigo-500" />
        Entries are stamped as <span className="font-semibold text-slate-700">{actor}</span>. Click a student to open their own mark-entry page and record every common unit they take.
      </p>

      {scope === "global" && (
        <p className="text-xs text-slate-500 mb-3 flex items-center gap-1.5">
          <Globe2 size={13} className="text-indigo-500" />
          Institute-wide search: type a name or admission number to pull students from any class into this unit — useful for common units.
        </p>
      )}

      {!unit ? (
        <div className="text-sm text-slate-400 flex items-center gap-2 mt-10 justify-center">
          <AlertCircle size={16} /> Select a class and unit first.
        </div>
      ) : mode === "coursework" ? (
        <CourseworkGrid unit={unit} students={students} data={data} setMark={setMark}
          showClass={scope === "global"} classById={classById} onOpen={setFocusId} />
      ) : (
        <MockGrid unit={unit} students={students} data={data} setMock={setMock}
          showClass={scope === "global"} classById={classById} onOpen={setFocusId} />
      )}
    </div>
  );
}

/** Single-student page: every unit in the institute, so common units can be filled in one place. */
function StudentMarksPage({ student, data, classById, setMark, setMock, onBack, actor, initialCommonOnly = false }: {
  student: StudentRec; data: AppData; classById: Map<string, ClassRec>; actor: string;
  setMark: (id: string, f: "c1" | "c2" | "a" | "e", v: string, unitId?: string) => void;
  setMock: (id: string, v: string, unitId?: string) => void;
  onBack: () => void;
  initialCommonOnly?: boolean;
}) {
  const [q, setQ] = useState("");
  const [onlyTaken, setOnlyTaken] = useState(false);
  const [commonOnly, setCommonOnly] = useState(initialCommonOnly);
  const home = classById.get(student.classId);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.units
      .map((u) => ({ u, c: classById.get(u.classId) }))
      .filter(({ u, c }) => {
        const m = data.marks[u.id]?.[student.id];
        const mk = data.mocks[u.id]?.[student.id];
        const taken = !!m || !!mk || u.classId === student.classId;
        if (commonOnly && !u.isCommon) return false;
        if (onlyTaken && !taken) return false;
        if (!needle) return true;
        return u.name.toLowerCase().includes(needle) || (c ? classLabel(c).toLowerCase().includes(needle) : false);
      });
  }, [data.units, data.marks, data.mocks, q, onlyTaken, commonOnly, student.id, student.classId, classById]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <ChevronRight size={14} className="rotate-180" /> Back to grid
        </button>
        <div className="ml-1">
          <div className="text-base font-semibold text-slate-800">{student.name}</div>
          <div className="text-xs text-slate-400">
            {student.admNo}{home && <span className="ml-2 text-indigo-500">{classLabel(home)}</span>}
          </div>
        </div>
        <div className="relative ml-auto">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-300" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter units or classes…" className={`pl-7 min-w-[240px] ${inputCls}`} />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          <input type="checkbox" checked={commonOnly} onChange={(e) => setCommonOnly(e.target.checked)} />
          Common units only
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          <input type="checkbox" checked={onlyTaken} onChange={(e) => setOnlyTaken(e.target.checked)} />
          Only units taken
        </label>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs text-slate-400 uppercase tracking-wide">
                <th className="px-4 py-2">Unit</th><th className="px-3 py-2">C1</th><th className="px-3 py-2">C2</th>
                <th className="px-3 py-2">Assignment</th><th className="px-3 py-2">End Term</th>
                <th className="px-3 py-2">Total</th><th className="px-3 py-2">Grade</th>
                <th className="px-3 py-2">Mock</th><th className="px-3 py-2">Entered by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ u, c }) => {
                const m = data.marks[u.id]?.[student.id] ?? {};
                const mk = data.mocks[u.id]?.[student.id];
                const total = totalFor(m);
                const has = [m.c1, m.c2, m.a, m.e].some((v) => v !== "" && v !== undefined && v !== null);
                const by = m.by ?? mk?.by;
                const at = m.at ?? mk?.at;
                return (
                  <tr key={u.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="px-4 py-1.5">
                      <div className="font-medium text-slate-700">{u.name}</div>
                      <div className="text-[11px] text-slate-400">
                        {c ? classLabel(c) : "—"}
                        {u.isCommon && <span className="ml-2 text-amber-600">common unit</span>}
                      </div>
                    </td>
                    {(["c1", "c2", "a", "e"] as const).map((field) => (
                      <td key={field} className="px-3 py-1.5">
                        <input type="number" value={m[field] ?? ""} onChange={(e) => setMark(student.id, field, e.target.value, u.id)} placeholder="—"
                          className="w-16 rounded border border-slate-200 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                      </td>
                    ))}
                    <td className="px-3 py-1.5 font-medium text-slate-700">{has ? total : "—"}</td>
                    <td className="px-3 py-1.5"><GradePill score={has ? total : ""} scale={data.gradeScale} /></td>
                    <td className="px-3 py-1.5">
                      <input type="number" value={mk?.score ?? ""} onChange={(e) => setMock(student.id, e.target.value, u.id)} placeholder="—"
                        className="w-16 rounded border border-amber-200 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
                    </td>
                    <td className="px-3 py-1.5 text-[11px] text-slate-400">
                      {by ? <><span className="text-slate-600 font-medium">{by}</span>{at && <div>{new Date(at).toLocaleDateString()}</div>}</> : "—"}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={9} className="px-4 py-6 text-center text-slate-400 text-sm">No units match.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-slate-400 mt-3">New entries on this page are recorded as <span className="font-medium text-slate-600">{actor}</span>.</p>
    </div>
  );
}

function StudentCell({ s, showClass, classById, onOpen }: { s: StudentRec; showClass: boolean; classById: Map<string, ClassRec>; onOpen?: ((studentId: string) => void) | undefined }) {
  const c = classById.get(s.classId);
  return (
    <td className="px-4 py-1.5">
      {onOpen ? (
        <button type="button" onClick={() => onOpen(s.id)} className="font-medium text-slate-700 hover:text-indigo-600 hover:underline text-left">
          {s.name}
        </button>
      ) : (
        <div className="font-medium text-slate-700">{s.name}</div>
      )}
      <div className="text-[11px] text-slate-400">
        {s.admNo}
        {showClass && c && <span className="ml-2 text-indigo-500">{c.programme} · {c.period ?? c.moduleLabel}</span>}
      </div>
    </td>
  );
}

function CourseworkGrid({ unit, students, data, setMark, showClass, classById, onOpen }: {
  unit: UnitRec; students: StudentRec[]; data: AppData;
  setMark: (id: string, f: "c1" | "c2" | "a" | "e", v: string) => void;
  showClass: boolean; classById: Map<string, ClassRec>;
  onOpen?: ((studentId: string) => void) | undefined;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100">
        <div className="text-sm font-semibold text-slate-800">{unit.name}</div>
        <div className="text-xs text-slate-400">C1 /{unit.maxC1} · C2 /{unit.maxC2} · Assignment /{unit.maxA} · End Term /{unit.maxE}</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs text-slate-400 uppercase tracking-wide">
              <th className="px-4 py-2">Student</th><th className="px-3 py-2">C1</th><th className="px-3 py-2">C2</th>
              <th className="px-3 py-2">Assignment</th><th className="px-3 py-2">End Term</th><th className="px-3 py-2">Total</th><th className="px-3 py-2">Grade</th>
            </tr>
          </thead>
          <tbody>
            {students.map((s) => {
              const m = data.marks[unit.id]?.[s.id] ?? {};
              const total = totalFor(m);
              const has = [m.c1, m.c2, m.a, m.e].some((v) => v !== "" && v !== undefined && v !== null);
              return (
                <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                  <StudentCell s={s} showClass={showClass} classById={classById} onOpen={onOpen} />
                  {(["c1", "c2", "a", "e"] as const).map((field) => (
                    <td key={field} className="px-3 py-1.5">
                      <input type="number" value={m[field] ?? ""} onChange={(e) => setMark(s.id, field, e.target.value)} placeholder="—"
                        className="w-16 rounded border border-slate-200 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    </td>
                  ))}
                  <td className="px-3 py-1.5 font-medium text-slate-700">{has ? total : "—"}</td>
                  <td className="px-3 py-1.5"><GradePill score={has ? total : ""} scale={data.gradeScale} /></td>
                </tr>
              );
            })}
            {students.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-400 text-sm">No students to show — try searching.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MockGrid({ unit, students, data, setMock, showClass, classById, onOpen }: {
  unit: UnitRec; students: StudentRec[]; data: AppData; setMock: (id: string, v: string) => void;
  showClass: boolean; classById: Map<string, ClassRec>;
  onOpen?: ((studentId: string) => void) | undefined;
}) {
  return (
    <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-amber-100 bg-amber-50">
        <div className="text-sm font-semibold text-amber-900">{unit.name} — Mock exam</div>
        <div className="text-xs text-amber-700/70">Raw score out of 100. Printed on the academic transcript.</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs text-slate-400 uppercase tracking-wide">
              <th className="px-4 py-2">Student</th><th className="px-3 py-2">Mock score</th><th className="px-3 py-2">Grade</th>
            </tr>
          </thead>
          <tbody>
            {students.map((s) => {
              const score = data.mocks[unit.id]?.[s.id]?.score;
              return (
                <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                  <StudentCell s={s} showClass={showClass} classById={classById} onOpen={onOpen} />
                  <td className="px-3 py-1.5">
                    <input type="number" value={score ?? ""} onChange={(e) => setMock(s.id, e.target.value)} placeholder="—"
                      className="w-20 rounded border border-slate-200 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
                  </td>
                  <td className="px-3 py-1.5"><GradePill score={score} scale={data.gradeScale} /></td>
                </tr>
              );
            })}
            {students.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-slate-400 text-sm">No students to show — try searching.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
