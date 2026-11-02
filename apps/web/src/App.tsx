import { Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { ExercisesPage } from '@/features/exercises/ExercisesPage';
import { LoginPage } from '@/features/login/LoginPage';
import { TeamsPage } from '@/features/teams/TeamsPage';
import { WizardProvider } from '@/features/wizard/WizardProvider';
import { OverviewPage } from '@/features/overview/OverviewPage';
import { OrganizationDetail } from '@/features/scenarios/OrganizationDetail';
import { OrganizationsPage } from '@/features/scenarios/OrganizationsPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<WizardProvider><AppShell /></WizardProvider>}>
          <Route index element={<OverviewPage />} />
          <Route path="exercises" element={<ExercisesPage />} />
          <Route path="teams" element={<TeamsPage />} />
          <Route path="organizations" element={<OrganizationsPage />} />
          <Route path="organizations/:id" element={<OrganizationDetail />} />
          <Route path="*" element={<OverviewPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
