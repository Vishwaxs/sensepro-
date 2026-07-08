import { BrowserRouter, Route, Routes } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { AuthProvider } from "@/lib/auth";
import { AppShell, RoleRedirect } from "@/components/layout/AppShell";
import { Login } from "@/pages/Login";
import { CaptureKiosk } from "@/pages/CaptureKiosk";
import { TeacherDashboard } from "@/pages/TeacherDashboard";
import { ManagementDashboard } from "@/pages/ManagementDashboard";
import { AdminDashboard } from "@/pages/AdminDashboard";
import { StudentPortal } from "@/pages/StudentPortal";
import { NotFound } from "@/pages/NotFound";

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<RoleRedirect />} />
            <Route path="/login" element={<Login />} />
            {/* Kiosk runs full-bleed outside the shell: the camera is the UI */}
            <Route path="/capture" element={<CaptureKiosk />} />
            <Route element={<AppShell />}>
              <Route path="/teacher" element={<TeacherDashboard />} />
              <Route path="/management" element={<ManagementDashboard />} />
              <Route path="/admin" element={<AdminDashboard />} />
              <Route path="/me" element={<StudentPortal />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </MotionConfig>
  );
}
