import { Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useScenarioCatalog } from '@/api/hooks';
import { EmptyState } from '@/components/EmptyState';
import { ErrorNote } from '@/components/ErrorNote';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { initials, organization, scenarioName, summaryStats } from './helpers';

export function OrganizationsPage() {
  const { data, isLoading, isError, error, refetch } = useScenarioCatalog();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const rows = (data ?? []).filter(
    (s) => !q || organization(s).toLowerCase().includes(q) || scenarioName(s).toLowerCase().includes(q) || JSON.stringify(s.vulnerabilities ?? []).toLowerCase().includes(q),
  );

  return (
    <>
      <PageHeader title="Organizations" description="Choose an organization to review its attack path and verified weaknesses." />
      <div className="relative mb-4 max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input className="pl-9" placeholder="Find an organization or CVE" aria-label="Find an organization or CVE" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {isError && <ErrorNote error={error} onRetry={() => refetch()} />}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title={query ? 'No organizations match your search' : 'No organizations loaded'} hint={query ? 'Try a different name or CVE.' : 'Add a scenario YAML and restart the API to load one.'} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((s) => {
            const stats = summaryStats(s);
            return (
              <li key={s.id}>
                <Link to={`/organizations/${s.id}`} className="block h-full">
                  <Card className="h-full transition-colors hover:bg-muted/50">
                    <CardContent className="flex gap-3">
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-border font-mono text-sm font-bold text-muted-foreground">{initials(s)}</span>
                      <div className="min-w-0">
                        <div className="truncate font-medium">{organization(s)}</div>
                        <div className="truncate text-xs text-muted-foreground">{scenarioName(s)}</div>
                        <div className="mt-2 text-xs text-muted-foreground">
                          {stats.assets} assets · {stats.networks} networks · {stats.objectives} objectives
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
