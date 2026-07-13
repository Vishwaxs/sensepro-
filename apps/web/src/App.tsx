import { BrowserRouter, Route, Routes } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { AuthProvider } from "@/lib/auth";
import { AppShell, RoleRedirect } from "@/components/layout/AppShell";
import { RequireRole } from "@/components/layout/RequireRole";
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
            <Route
              path="/capture"
              element={
                <RequireRole roles={["teacher", "admin"]}>
                  <CaptureKiosk />
                </RequireRole>
              }
            />
            <Route element={<AppShell />}>
              <Route
                path="/teacher"
                element={
                  <RequireRole roles={["teacher", "admin"]}>
                    <TeacherDashboard />
                  </RequireRole>
                }
              />
              <Route
                path="/management"
                element={
                  <RequireRole roles={["management", "admin"]}>
                    <ManagementDashboard />
                  </RequireRole>
                }
              />
              <Route
                path="/admin"
                element={
                  <RequireRole roles={["admin"]}>
                    <AdminDashboard />
                  </RequireRole>
                }
              />
              <Route
                path="/me"
                element={
                  <RequireRole roles={["teacher", "management", "admin", "student"]}>
                    <StudentPortal />
                  </RequireRole>
                }
              />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </MotionConfig>
  );
}
