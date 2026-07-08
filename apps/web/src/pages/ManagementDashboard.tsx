import { motion } from "framer-motion";
import { Eye, GaugeCircle, Presentation, ShieldCheck } from "lucide-react";
import { mockSessions, mockZones } from "@/lib/mock";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { BiasChart } from "@/components/charts/BiasChart";
import { ZoneStrip } from "@/components/charts/ZoneStrip";

const rise = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

export function ManagementDashboard() {
  const avgVnei =
    mockZones.filter((z) => !z.suppressed).reduce((a, z) => a + z.vnei, 0) /
    Math.max(1, mockZones.filter((z) => !z.suppressed).length);
  const visible = mockZones.reduce((a, z) => a + (z.suppressed ? 0 : z.n_visible), 0);

  return (
    <div>
      <PageHeader
        title="Management analytics"
        subtitle="Class- and zone-level engagement only. Per-student engagement does not exist in this system — not in the schema, the API, or here."
        action={
          <Badge tone="accent">
            <Eye className="size-3" aria-hidden="true" /> coverage {visible}/42 seats
          </Badge>
        }
      />

      <motion.div
        {...rise}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        <StatCard
          label="Avg VNEI (today)"
          value={avgVnei * 100}
          decimals={0}
          suffix="%"
          icon={GaugeCircle}
          note="visibility-normalised, zone-weighted"
        />
        <StatCard
          label="Sessions this week"
          value={mockSessions.length}
          icon={Presentation}
          note="across all monitored sections"
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
              title="Fairness check — naive mean vs VNEI"
              hint="A naive average over-counts the camera-visible front rows. VNEI re-weights by per-zone visibility so every seat counts equally."
            />
            <CardBody>
              <BiasChart zones={mockZones} />
            </CardBody>
          </Card>
        </motion.div>

        <motion.div
          {...rise}
          transition={{ duration: 0.2, ease: "easeOut", delay: 0.1 }}
          className="xl:col-span-2"
        >
          <Card>
            <CardHeader
              title="Camera coverage by zone"
              hint="What the analytics can honestly claim to see."
            />
            <CardBody>
              <ZoneStrip zones={mockZones} />
            </CardBody>
          </Card>

          <Card className="mt-6">
            <CardHeader title="What this dashboard will never show" />
            <CardBody>
              <ul className="flex flex-col gap-2.5 text-[13px] leading-relaxed text-muted">
                <li className="flex gap-2.5">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-bad" aria-hidden="true" />
                  Per-student engagement scores — engagement is measured at zone level only.
                </li>
                <li className="flex gap-2.5">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-bad" aria-hidden="true" />
                  Emotion labels. Only observable behaviour: head pose, eye-closure, phone, stillness.
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
