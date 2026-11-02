import { Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { ExercisesPage } from '@/features/exercises/ExercisesPage';
import { InfrastructurePage } from '@/features/infrastructure/InfrastructurePage';
import { MissionControlPage } from '@/features/mission/MissionControlPage';
import { ReportDetail, ReportsPage } from '@/features/reports/ReportsPage';
import { ScoreboardPage } from '@/features/scoreboard/ScoreboardPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
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
          <Route path="mission-control" element={<MissionControlPage />} />
          <Route path="infrastructure" element={<InfrastructurePage />} />
          <Route path="scoreboard" element={<ScoreboardPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="reports/:id" element={<ReportDetail />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="teams" element={<TeamsPage />} />
          <Route path="organizations" element={<OrganizationsPage />} />
          <Route path="organizations/:id" element={<OrganizationDetail />} />
          <Route path="*" element={<OverviewPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
