import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ShieldCheck, Camera, BarChart3, Users, Eye, Brain, Lock,
  ChevronRight, ArrowRight,
} from "lucide-react";

export const Route = createFileRoute("/landing")({
  head: () => ({
    meta: [
      { title: "SensePro+ · Classroom Command Center" },
      { name: "description", content: "Browser-based attendance, proctor review, and fairness-aware engagement analytics for higher education." },
      { property: "og:title", content: "SensePro+ · Classroom Command Center" },
      { property: "og:description", content: "Mission-control for the classroom — privacy-first, bias-aware." },
    ],
  }),
  component: LandingPage,
});

const PILLARS = [
  { icon: Eye, title: "Browser-based capture", desc: "No hardware, no drivers. Any webcam in Chrome ships frames to the inference server over a WebSocket." },
  { icon: Brain, title: "Fairness-aware analytics", desc: "VNEI corrects for visibility bias. Zone aggregates suppress when k < 5. Never per-student engagement." },
  { icon: Lock, title: "Privacy by design", desc: "Frames never stored. Embeddings purged post-enrollment. Hash-chained audit trail. DPDP-aligned consent." },
];

const INVARIANTS = [
  "No raw frames stored after inference",
  "No per-student engagement scores",
  "No emotion classification or behavioral profiling",
  "Aggregates suppressed when k < 5",
  "Human-in-the-loop proctoring — flags, never verdicts",
  "Student can withdraw consent + delete all data at any time",
];

const ROLES = [
  { label: "Teacher", desc: "Live roster, session PDF, proctor review queue.", mono: "TCH" },
  { label: "Management", desc: "VNEI trends, zone engagement, session compare.", mono: "MGT" },
  { label: "Admin", desc: "Devices, users, consent registry, audit chain.", mono: "ADM" },
  { label: "Student", desc: "Attendance history, consent status, data deletion.", mono: "ME" },
];

function LandingPage() {
  return (
    <div className="app-bg min-h-screen text-[color:var(--ink)]">
      {/* Top nav */}
      <nav className="glass-chrome fixed top-0 left-0 right-0 z-50 flex h-14 items-center justify-between px-6 sm:px-10 border-0 border-b border-[color:var(--line)]">
        <div className="flex items-center gap-3">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-md"
            style={{ background: "linear-gradient(135deg, var(--primary-deep), var(--primary))" }}
          >
            <ShieldCheck className="h-3.5 w-3.5 text-white" strokeWidth={2.5} />
          </div>
          <span className="font-display text-sm font-extrabold tracking-tight">
            SensePro<span className="text-[color:var(--accent)]">+</span>
          </span>
        </div>
        <Link
          to="/login"
          className="sp-btn sp-btn-primary h-9 px-4 text-xs"
        >
          Sign in <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </nav>

      {/* Hero */}
      <section className="flex min-h-[85vh] flex-col items-center justify-center px-6 pt-20 text-center">
        <div className="font-mono-nums text-[11px] uppercase tracking-[0.22em] text-[color:var(--accent)]">
          § classroom command center
        </div>
        <h1 className="mt-4 max-w-3xl font-display text-5xl font-extrabold leading-[1.1] tracking-tight sm:text-6xl">
          Attendance that{" "}
          <span className="bg-gradient-to-r from-[color:var(--primary)] via-[color:var(--accent)] to-[color:var(--primary)] bg-clip-text text-transparent">
            sees the class,
          </span>
          {" "}not the student
        </h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed text-[color:var(--muted)]">
          Browser-based face recognition for attendance and exam proctoring —
          built with visibility-normalised engagement, privacy invariants baked in,
          and human-in-the-loop review for every proctor flag.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            to="/capture"
            className="sp-btn sp-btn-primary h-12 px-6 text-sm"
          >
            Open capture <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            to="/login"
            className="sp-btn sp-btn-secondary h-12 px-6 text-sm"
          >
            Dashboard
          </Link>
        </div>
      </section>

      {/* Pillars */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <div className="grid gap-6 md:grid-cols-3">
          {PILLARS.map((p) => (
            <div key={p.title} className="glass-panel card-hover p-6">
              <p.icon className="h-7 w-7 text-[color:var(--accent)]" strokeWidth={1.8} />
              <h3 className="mt-4 font-display text-lg font-extrabold tracking-tight">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[color:var(--muted)]">{p.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Invariants */}
      <section className="mx-auto max-w-3xl px-6 py-16">
        <div className="glass-panel p-8">
          <div className="font-mono-nums text-[10px] uppercase tracking-[0.22em] text-[color:var(--accent)]">
            § non-negotiable
          </div>
          <h2 className="mt-2 font-display text-2xl font-extrabold tracking-tight">
            Privacy invariants
          </h2>
          <p className="mt-2 text-sm text-[color:var(--muted)]">
            These rules are enforced at architecture level. They cannot be overridden by configuration.
          </p>
          <ul className="mt-6 space-y-3">
            {INVARIANTS.map((inv) => (
              <li key={inv} className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--ok)]" strokeWidth={2} />
                <span className="text-sm">{inv}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Roles */}
      <section className="mx-auto max-w-5xl px-6 py-16">
        <div className="text-center">
          <div className="font-mono-nums text-[10px] uppercase tracking-[0.22em] text-[color:var(--muted)]">
            § role-based access
          </div>
          <h2 className="mt-2 font-display text-2xl font-extrabold tracking-tight">
            Four consoles, one system
          </h2>
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ROLES.map((r) => (
            <div key={r.label} className="glass-panel-2 card-hover p-5">
              <div className="font-mono-nums text-[10px] uppercase tracking-[0.18em] text-[color:var(--accent)]">
                {r.mono}
              </div>
              <h3 className="mt-2 font-display text-base font-extrabold">{r.label}</h3>
              <p className="mt-2 text-xs leading-relaxed text-[color:var(--muted)]">{r.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[color:var(--line)] py-8 text-center">
        <div className="font-mono-nums text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
          SensePro+ · MCA Major Project · CHRIST University · 2026
        </div>
      </footer>
    </div>
  );
}
