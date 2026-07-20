import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Eye, GaugeCircle, LayoutGrid, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import { fetchActiveSession } from "@/lib/data/roster";
import type { ActiveSession } from "@/lib/data/roster";
import { fetchZoneAggregates, latestWindow } from "@/lib/data/engagement";
import type { ZoneAggregateRow } from "@/lib/data/engagement";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";
import { VneiPanel } from "@/components/charts/VneiPanel";

const rise = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

type LoadState = "loading" | "ready" | "error";

/** Zone-level engagement only — this route never names a student, by design
 *  (the table it reads has no student column to begin with). */
export function ManagementDashboard() {
  const [load, setLoad] = useState<LoadState>("loading");
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [rows, setRows] = useState<ZoneAggregateRow[]>([]);

  const refresh = useCallback(async () => {
    try {
      const active = await fetchActiveSession();
      setSession(active);
      setRows(active ? await fetchZoneAggregates(active.id) : []);
      setLoad("ready");
    } catch {
      setLoad("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { byZone } = latestWindow(rows);
  const latest = [...byZone.values()];
  const tracked = latest.reduce((a, r) => a + r.n_tracked, 0);
  const enrolled = latest.reduce((a, r) => a + r.enrolled_in_zone, 0);
  /* Weighted by how many faces each zone's number actually rests on. */
  const avgVnei = tracked ? latest.reduce((a, r) => a + r.vnei * r.n_tracked, 0) / tracked : 0;
  const windows = new Set(rows.map((r) => r.window_start)).size;

  return (
    <div>
      <PageHeader
        title="Management analytics"
        subtitle="Class- and zone-level engagement only. Per-student engagement does not exist in this system — not in the schema, the API, or here."
        action={
          <div className="flex items-center gap-2">
            {latest.length > 0 ? (
              <Badge tone="accent">
                <Eye className="size-3" aria-hidden="true" /> tracking {tracked}/{enrolled} enrolled
              </Badge>
            ) : null}
            <Button variant="outline" onClick={() => void refresh()}>
              <RefreshCw className="size-4" aria-hidden="true" /> Refresh
            </Button>
          </div>
        }
      />

      <motion.div
        {...rise}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        <StatCard
          label="Avg VNEI (latest window)"
          value={avgVnei * 100}
          decimals={0}
          suffix="%"
          icon={GaugeCircle}
          note="visibility-normalised, weighted by tracked faces"
        />
        <StatCard
          label="Windows recorded"
          value={windows}
          icon={LayoutGrid}
          note={session ? "this live session" : "no live session"}
        />
        <StatCard
          label="Privacy floor"
          value={5}
          icon={ShieldCheck}
          tone="ok"
          note="k-anonymity: aggregates under n=5 are suppressed"
        />
      </motion.div>

      <div className="mt-6 grid gap-6 xl:grid-cols-5">
        <motion.div
          {...rise}
          transition={{ duration: 0.2, ease: "easeOut", delay: 0.05 }}
          className="xl:col-span-3"
        >
          <Card>
            <CardHeader
              title="VNEI by zone"
              hint="Live from engagement_zone_aggregates under RLS. Every number declares its coverage; thin evidence is marked, missing evidence is withheld."
            />
            <CardBody>
              {load === "loading" ? (
                <p className="py-8 text-center font-mono text-[12.5px] text-muted">
                  loading aggregates…
                </p>
              ) : load === "error" ? (
                <EmptyState
                  icon={WifiOff}
                  title="Could not load engagement data"
                  hint="Check your connection and role, then refresh."
                />
              ) : rows.length === 0 ? (
                <EmptyState
                  icon={GaugeCircle}
                  title={session ? "No windows recorded yet" : "No live session"}
                  hint="Zone aggregates appear once a session runs with at least 5 tracked faces in a zone — smaller windows are suppressed, never estimated."
                />
              ) : (
                <VneiPanel rows={rows} />
              )}
            </CardBody>
          </Card>
        </motion.div>

        <motion.div
          {...rise}
          transition={{ duration: 0.2, ease: "easeOut", delay: 0.1 }}
          className="xl:col-span-2"
        >
          <Card>
            <CardHeader title="What this dashboard will never show" />
            <CardBody>
              <ul className="flex flex-col gap-2.5 text-[13px] leading-relaxed text-muted">
                <li className="flex gap-2.5">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-bad" aria-hidden="true" />
                  Per-student engagement scores — engagement is measured at zone level only.
                </li>
                <li className="flex gap-2.5">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-bad" aria-hidden="true" />
                  Emotion labels. Only observable behaviour: head pose, phone, stillness.
                </li>
                <li className="flex gap-2.5">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-bad" aria-hidden="true" />
                  Aggregates over fewer than 5 students — suppressed by a database constraint.
                </li>
              </ul>
            </CardBody>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
