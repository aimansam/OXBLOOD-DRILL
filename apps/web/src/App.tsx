import { Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { ExercisesPage } from '@/features/exercises/ExercisesPage';
import { LoginPage } from '@/features/login/LoginPage';
import { OverviewPage } from '@/features/overview/OverviewPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="exercises" element={<ExercisesPage />} />
          <Route path="*" element={<OverviewPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
