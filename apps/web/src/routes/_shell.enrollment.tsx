import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Fingerprint,
  Loader2,
  RefreshCw,
  Search,
  Upload,
  Users,
  Video,
  X,
} from "lucide-react";
import { guardRoute } from "@/lib/auth-guard";
import { supabase, supabaseAuth } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { API_BASE } from "@/lib/api";

export const Route = createFileRoute("/_shell/enrollment")({
  beforeLoad: guardRoute(["admin"]),
  head: () => ({
    meta: [{ title: "Enrollment · SensePro+" }, { name: "robots", content: "noindex" }],
  }),
  component: EnrollmentPage,
});

const MAX_FILE_MB = 50;
const ALLOWED_TYPES = ["video/mp4", "video/quicktime", "video/x-msvideo", "video/webm"];

type Framing = "knee" | "waist";
type Quality = "GOOD" | "OK" | "WEAK" | "NONE";

interface StudentRow {
  id: string;
  reg_no: string;
  full_name: string;
  class_section: string | null;
}

interface EmbStat {
  photo: number;
  video: number;
  video_knee: number;
  video_waist: number;
  total: number;
}

/** One row of the enrollment_coverage view (migrations 0017/0018): the roster joined
 *  to per-student template counts by provenance. `video` counts templates
 *  written before the `source` column existed (NULL source). Never carries a
 *  vector — see the view's comment. */
interface CoverageRow {
  student_id: string;
  reg_no: string;
  full_name: string;
  class_section: string | null;
  total: number;
  photo: number;
  video_knee: number;
  video_waist: number;
  video: number;
}

interface EnrollResult {
  verdict: "PASS" | "RETRY";
  reason: string;
  frames_extracted: number;
  frames_accepted: number;
  reject_reasons: Record<string, number>;
  pose_bins: string[];
  embeddings_created: number;
  self_match_score: number | null;
  framing: Framing;
  source: string;
}

const EMPTY_STAT: EmbStat = { photo: 0, video: 0, video_knee: 0, video_waist: 0, total: 0 };

const FRAMING_GUIDE: Record<Framing, { title: string; blurb: string }> = {
  knee: {
    title: "Knee framing — face SMALL in frame",
    blurb:
      "Stand back: student visible head-to-knees. Mimics mid/back-row apparent face size at classroom distance.",
  },
  waist: {
    title: "Waist framing — face MEDIUM in frame",
    blurb: "Closer: head-to-waist. Mimics the front rows.",
  },
};

function qualityOf(st: EmbStat): Quality {
  if (st.total === 0) return "NONE";
  const hasPhoto = st.photo > 0;
  const hasKnee = st.video_knee > 0;
  const hasWaist = st.video_waist > 0;
  const hasVideo = hasKnee || hasWaist || st.video > 0;
  if (hasPhoto && hasKnee && hasWaist) return "GOOD";
  if (hasPhoto && hasVideo) return "OK";
  return "WEAK";
}

const QUALITY_META: Record<Quality, { label: string; tone: string }> = {
  GOOD: {
    label: "GOOD",
    tone: "border-[color:var(--ok)]/45 bg-[color:var(--ok)]/10 text-[color:var(--ok)]",
  },
  OK: {
    label: "OK",
    tone: "border-[color:var(--primary)]/45 bg-[color:var(--primary)]/10 text-[color:var(--primary)]",
  },
  WEAK: {
    label: "WEAK",
    tone: "border-[color:var(--warn)]/45 bg-[color:var(--warn)]/10 text-[color:var(--warn)]",
  },
  NONE: {
    label: "NONE",
    tone: "border-[color:var(--bad)]/40 bg-[color:var(--bad)]/10 text-[color:var(--bad)]",
  },
};

function EnrollmentPage() {
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [stats, setStats] = useState<Record<string, EmbStat>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Roster + per-student template counts in ONE read, from the
      // enrollment_coverage view (migrations 0017/0018). This page used to page
      // through `embeddings` directly, but that table is deliberately never
      // granted to `authenticated` — it holds the raw vector(512) face
      // templates, which must not reach a browser. The read was denied, and
      // because it ran first the page never reached its students query either,
      // so the whole station showed "Could not load the roster" with 0 on every
      // tile. The view exposes counts by provenance and nothing else: no
      // vector, no quality, no per-embedding row. It also aggregates
      // server-side, so the old 1000-row pagination loop is gone — one row per
      // student regardless of how many templates each has.
      const { data, error } = await supabase
        .from("enrollment_coverage")
        .select(
          "student_id, reg_no, full_name, class_section, total, photo, video_knee, video_waist, video",
        )
        .order("reg_no");
      if (error) throw error;

      const rows = (data ?? []) as CoverageRow[];
      const agg: Record<string, EmbStat> = {};
      for (const r of rows) {
        agg[r.student_id] = {
          total: r.total,
          photo: r.photo,
          video_knee: r.video_knee,
          video_waist: r.video_waist,
          // Templates predating the `source` column (NULL). The old code
          // counted source === "video", a value the CHECK constraint never
          // permits, so legacy templates were silently dropped from the total.
          video: r.video,
        };
      }
      setStudents(
        rows.map((r) => ({
          id: r.student_id,
          reg_no: r.reg_no,
          full_name: r.full_name,
          class_section: r.class_section,
        })),
      );
      setStats(agg);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the roster.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const statFor = useCallback((id: string) => stats[id] ?? EMPTY_STAT, [stats]);

  const summary = useMemo(() => {
    const counts: Record<Quality, number> = { GOOD: 0, OK: 0, WEAK: 0, NONE: 0 };
    for (const s of students) counts[qualityOf(statFor(s.id))] += 1;
    return counts;
  }, [students, statFor]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return students.filter((s) => {
      if (q && !s.full_name.toLowerCase().includes(q) && !s.reg_no.toLowerCase().includes(q)) {
        return false;
      }
      if (onlyIncomplete && qualityOf(statFor(s.id)) === "GOOD") return false;
      return true;
    });
  }, [students, query, onlyIncomplete, statFor]);

  const selected = students.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <header>
        <div className="font-mono-nums text-[11px] uppercase tracking-[0.2em] text-[color:var(--muted)]">
          Section enrollment station
        </div>
        <h2 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-[color:var(--ink)]">
          Enrollment dashboard
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--muted)]">
          DSLR photos are the primary attendance anchors; two short videos per student — knee and
          waist framing — add multi-scale templates so recognition marks PRESENT faster at classroom
          distance. Videos are processed in memory and deleted immediately; only embeddings are
          stored.
        </p>
      </header>

      {/* Progress summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <SummaryTile label="Students" value={students.length} icon />
        {(["GOOD", "OK", "WEAK", "NONE"] as Quality[]).map((q) => (
          <SummaryTile
            key={q}
            label={QUALITY_META[q].label}
            value={summary[q]}
            tone={QUALITY_META[q].tone}
          />
        ))}
      </div>

      {loadError && (
        <div className="flex items-center justify-between rounded-md border border-[color:var(--bad)]/50 bg-[color:var(--bad)]/10 px-4 py-3 text-sm text-[color:var(--bad)]">
          <span>
            <AlertTriangle className="mb-0.5 mr-1.5 inline-block h-4 w-4" />
            {loadError}
          </span>
          <button onClick={() => void load()} className="sp-btn sp-btn-secondary">
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* Roster table */}
        <section className="glass-panel overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-[color:var(--line)] p-4">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--muted)]" />
              <input
                type="text"
                placeholder="Search by name or reg number…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-10 w-full rounded-md border border-[color:var(--line)] bg-[color:var(--surface)] pl-10 pr-4 text-sm text-[color:var(--ink)] placeholder-[color:var(--muted)] outline-none focus:border-[color:var(--primary)]"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-[color:var(--muted)]">
              <input
                type="checkbox"
                checked={onlyIncomplete}
                onChange={(e) => setOnlyIncomplete(e.target.checked)}
                className="h-4 w-4 accent-[color:var(--primary)]"
              />
              Not GOOD only
            </label>
          </div>

          {loading ? (
            <div className="grid place-items-center py-16 text-[color:var(--muted)]">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="grid place-items-center gap-2 py-16 text-center text-[color:var(--muted)]">
              <Users className="h-7 w-7 opacity-60" />
              <div className="text-sm">
                {students.length === 0
                  ? "No students found for your account."
                  : "No students match."}
              </div>
            </div>
          ) : (
            <div className="max-h-[62vh] overflow-y-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 z-[1] bg-[color:var(--surface-2)]/90 backdrop-blur">
                  <tr className="text-left font-mono-nums text-[10px] uppercase tracking-[0.16em] text-[color:var(--muted)]">
                    <th className="px-4 py-2.5 font-medium">Reg / Name</th>
                    <th className="px-2 py-2.5 text-center font-medium">Ph</th>
                    <th className="px-2 py-2.5 text-center font-medium">Kn</th>
                    <th className="px-2 py-2.5 text-center font-medium">Wa</th>
                    <th className="px-2 py-2.5 text-center font-medium">Σ</th>
                    <th className="px-4 py-2.5 text-right font-medium">Quality</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => {
                    const st = statFor(s.id);
                    const q = qualityOf(st);
                    return (
                      <tr
                        key={s.id}
                        onClick={() => setSelectedId(s.id)}
                        className={cn(
                          "cursor-pointer border-t border-[color:var(--line)]/60 transition-colors",
                          selectedId === s.id
                            ? "bg-[color:var(--primary)]/10"
                            : "hover:bg-[color:var(--surface-2)]/50",
                        )}
                      >
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-[color:var(--ink)]">{s.full_name}</div>
                          <div className="font-mono-nums text-[11px] text-[color:var(--muted)]">
                            {s.reg_no}
                            {s.class_section ? ` · ${s.class_section}` : ""}
                          </div>
                        </td>
                        <SlotCell on={st.photo > 0} />
                        <SlotCell on={st.video_knee > 0} />
                        <SlotCell on={st.video_waist > 0} />
                        <td className="px-2 py-2.5 text-center font-mono-nums text-xs text-[color:var(--muted)]">
                          {st.total}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <span
                            className={cn(
                              "inline-block rounded-full border px-2 py-0.5 font-mono-nums text-[10px] font-semibold tracking-wide",
                              QUALITY_META[q].tone,
                            )}
                          >
                            {QUALITY_META[q].label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Detail / upload panel */}
        <div className="space-y-4">
          {selected ? (
            <StudentDetail
              key={selected.id}
              student={selected}
              stat={statFor(selected.id)}
              onEnrolled={() => void load()}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <div className="glass-panel grid place-items-center gap-2 p-8 text-center text-[color:var(--muted)]">
              <Video className="h-7 w-7 opacity-60" />
              <div className="text-sm">Select a student to upload their framing videos.</div>
            </div>
          )}

          <div className="rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)]/40 px-4 py-3 text-xs text-[color:var(--muted)]">
            <Fingerprint className="mb-0.5 mr-1 inline-block h-3.5 w-3.5" />
            The video is processed in memory and deleted immediately; only mathematical embeddings
            are stored.
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone?: string;
  icon?: boolean;
}) {
  return (
    <div className={cn("glass-panel px-4 py-3", tone && "border")}>
      <div className="flex items-center gap-1.5 font-mono-nums text-[10px] uppercase tracking-[0.16em] text-[color:var(--muted)]">
        {icon && <Users className="h-3 w-3" />}
        {label}
      </div>
      <div className="mt-0.5 font-display text-2xl font-extrabold text-[color:var(--ink)]">
        {value}
      </div>
    </div>
  );
}

function SlotCell({ on }: { on: boolean }) {
  return (
    <td className="px-2 py-2.5 text-center">
      <span
        className={cn(
          "inline-block h-2.5 w-2.5 rounded-full",
          on ? "bg-[color:var(--ok)]" : "bg-[color:var(--line)]",
        )}
        aria-label={on ? "enrolled" : "missing"}
      />
    </td>
  );
}

function StudentDetail({
  student,
  stat,
  onEnrolled,
  onClose,
}: {
  student: StudentRow;
  stat: EmbStat;
  onEnrolled: () => void;
  onClose: () => void;
}) {
  return (
    <section className="glass-panel p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="font-display text-lg font-bold text-[color:var(--ink)]">
            {student.full_name}
          </div>
          <div className="font-mono-nums text-xs text-[color:var(--muted)]">
            {student.reg_no}
            {student.class_section ? ` · ${student.class_section}` : ""}
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-[color:var(--muted)] hover:text-[color:var(--ink)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Photo anchor status (read-only; photos come from the bulk import CLI) */}
      <div className="mt-4 flex items-center gap-2 rounded-md border border-[color:var(--line)] bg-[color:var(--surface-2)]/40 px-3 py-2 text-xs">
        <span
          className={cn(
            "inline-block h-2.5 w-2.5 rounded-full",
            stat.photo > 0 ? "bg-[color:var(--ok)]" : "bg-[color:var(--warn)]",
          )}
        />
        <span className="text-[color:var(--muted)]">
          {stat.photo > 0
            ? `Photo anchors: ${stat.photo} templates (bulk import)`
            : "No photo anchors yet — run the bulk photo import"}
        </span>
      </div>

      <div className="mt-4 space-y-4">
        <FramingSlot
          framing="knee"
          student={student}
          existing={stat.video_knee}
          onEnrolled={onEnrolled}
        />
        <FramingSlot
          framing="waist"
          student={student}
          existing={stat.video_waist}
          onEnrolled={onEnrolled}
        />
      </div>
    </section>
  );
}

function FramingSlot({
  framing,
  student,
  existing,
  onEnrolled,
}: {
  framing: Framing;
  student: StudentRow;
  existing: number;
  onEnrolled: () => void;
}) {
  const guide = FRAMING_GUIDE[framing];
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<EnrollResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pickFile = (f: File | null) => {
    setError(null);
    setResult(null);
    if (!f) {
      setFile(null);
      return;
    }
    if (!ALLOWED_TYPES.includes(f.type)) {
      setError(`Unsupported file (${f.type || "unknown"}). Use MP4, MOV, AVI, or WebM.`);
      return;
    }
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`Too large (${(f.size / 1024 / 1024).toFixed(1)} MB). Max ${MAX_FILE_MB} MB.`);
      return;
    }
    setFile(f);
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setProgress(15);
    setError(null);
    setResult(null);
    try {
      const {
        data: { session },
      } = await supabaseAuth.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const form = new FormData();
      form.append("student_id", student.id);
      form.append("framing", framing);
      form.append("replace", String(existing > 0)); // re-upload replaces this slot
      form.append("video", file);
      setProgress(35);

      const resp = await fetch(`${API_BASE}/v1/enroll/video`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: form,
      });
      setProgress(90);

      const body = await resp.json().catch(() => ({ detail: resp.statusText }));
      if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`);

      setResult(body as EnrollResult);
      setProgress(100);
      setFile(null);
      onEnrolled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="rounded-lg border border-[color:var(--line)] bg-[color:var(--surface)]/40 p-4">
      <div className="flex items-center justify-between">
        <div className="font-mono-nums text-[10px] uppercase tracking-[0.2em] text-[color:var(--accent)]">
          {framing} video
        </div>
        {existing > 0 && (
          <span className="inline-flex items-center gap-1 font-mono-nums text-[10px] text-[color:var(--ok)]">
            <CheckCircle2 className="h-3 w-3" /> {existing} templates
          </span>
        )}
      </div>
      <div className="mt-1 text-sm font-medium text-[color:var(--ink)]">{guide.title}</div>
      <p className="mt-0.5 text-[11px] text-[color:var(--muted)]">{guide.blurb}</p>
      <p className="mt-1 text-[11px] text-[color:var(--muted)]">
        ~25s: centre 3s → slow turn left ~30° &amp; back → right &amp; back → up → down → glasses
        off last 5s.
      </p>

      <div
        className={cn(
          "mt-3 grid place-items-center rounded-md border-2 border-dashed py-6 transition-colors",
          file
            ? "border-[color:var(--ok)]/50 bg-[color:var(--ok)]/5"
            : "border-[color:var(--line)]/70 hover:border-[color:var(--primary)]/50",
        )}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pickFile(e.dataTransfer.files[0] ?? null);
        }}
      >
        {file ? (
          <div className="flex flex-col items-center gap-1 text-center">
            <Video className="h-6 w-6 text-[color:var(--ok)]" />
            <div className="text-xs font-medium text-[color:var(--ink)]">{file.name}</div>
            <div className="font-mono-nums text-[10px] text-[color:var(--muted)]">
              {(file.size / 1024 / 1024).toFixed(1)} MB
            </div>
            <button
              onClick={() => setFile(null)}
              className="text-[10px] text-[color:var(--bad)] hover:underline"
            >
              Remove
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileRef.current?.click()}
            className="flex flex-col items-center gap-1.5 text-xs text-[color:var(--muted)]"
          >
            <Upload className="h-5 w-5" />
            <span>
              Drag &amp; drop or <span className="text-[color:var(--primary)]">browse</span>
            </span>
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/quicktime,video/x-msvideo,video/webm"
          className="hidden"
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />
      </div>

      {error && (
        <div className="mt-2 rounded-md border border-[color:var(--bad)]/50 bg-[color:var(--bad)]/10 px-3 py-2 text-xs text-[color:var(--bad)]">
          <AlertTriangle className="mb-0.5 mr-1 inline-block h-3.5 w-3.5" />
          {error}
        </div>
      )}

      {result && <SlotResult result={result} />}

      <button
        disabled={!file || uploading}
        onClick={upload}
        className="sp-btn sp-btn-primary mt-3 w-full"
      >
        {uploading ? (
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Processing ({progress}%)…
          </span>
        ) : existing > 0 ? (
          `Replace ${framing} video`
        ) : (
          `Upload ${framing} video`
        )}
      </button>
    </div>
  );
}

function SlotResult({ result }: { result: EnrollResult }) {
  const pass = result.verdict === "PASS";
  const rejects = Object.entries(result.reject_reasons);
  return (
    <div
      className={cn(
        "mt-2 rounded-md border px-3 py-2.5 text-xs",
        pass
          ? "border-[color:var(--ok)]/45 bg-[color:var(--ok)]/8"
          : "border-[color:var(--warn)]/45 bg-[color:var(--warn)]/8",
      )}
    >
      <div
        className={cn(
          "font-mono-nums text-[10px] font-semibold uppercase tracking-[0.18em]",
          pass ? "text-[color:var(--ok)]" : "text-[color:var(--warn)]",
        )}
      >
        {pass ? "Pass" : "Retry"}
      </div>
      <p className="mt-1 text-[color:var(--muted)]">{result.reason}</p>
      <div className="mt-2 grid grid-cols-3 gap-2 font-mono-nums text-[11px] text-[color:var(--ink)]">
        <Metric label="Embeds" value={result.embeddings_created} />
        <Metric label="Frames" value={`${result.frames_accepted}/${result.frames_extracted}`} />
        <Metric
          label="Self-match"
          value={result.self_match_score != null ? result.self_match_score.toFixed(3) : "—"}
        />
      </div>
      {result.pose_bins.length > 0 && (
        <div className="mt-2 text-[10px] text-[color:var(--muted)]">
          Pose bins: <span className="text-[color:var(--ink)]">{result.pose_bins.join(", ")}</span>
        </div>
      )}
      {rejects.length > 0 && (
        <div className="mt-1 text-[10px] text-[color:var(--muted)]">
          Rejected: {rejects.map(([k, v]) => `${k}×${v}`).join(" · ")}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-[color:var(--line)] bg-[color:var(--surface-2)]/40 px-2 py-1 text-center">
      <div className="text-sm font-bold text-[color:var(--ink)]">{value}</div>
      <div className="text-[9px] uppercase tracking-[0.14em] text-[color:var(--muted)]">
        {label}
      </div>
    </div>
  );
}
