import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { EmptyState } from '@/components/EmptyState';
import { ErrorNote } from '@/components/ErrorNote';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatWhen } from '@/lib/utils';
import { reportResult, severityTone, useReport, useReports } from './api';

export function ReportsPage() {
  const { data, isLoading, isError, error, refetch } = useReports();
  return (
    <>
      <PageHeader title="Reports" description="After-action reports and findings from finished exercises." />
      {isError && <ErrorNote error={error} onRetry={() => refetch()} />}
      {isLoading ? <Skeleton className="h-40 w-full" /> : (data ?? []).length === 0 ? (
        <EmptyState title="No reports yet" hint="Reports appear after an exercise is graded." />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {(data ?? []).map((r) => (
            <li key={r.id}>
              <Link to={`/reports/${r.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted">
                <div className="min-w-0">
                  <div className="truncate font-medium">{r.title || 'Report'}</div>
                  <div className="text-xs text-muted-foreground">{(r.report_type ?? 'after_action').replace(/_/g, ' ')} · {formatWhen(r.created_at)}</div>
                </div>
                <div className="flex items-center gap-4 text-right">
                  {r.quality_score != null && <span className="tabular-nums">{Math.round(r.quality_score)}</span>}
                  <span className={cn('text-xs', r.status === 'graded' ? 'text-success' : 'text-warning')}>{reportResult(r)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function ReportDetail() {
  const { id } = useParams();
  const { data, isLoading, isError, error } = useReport(Number(id) || null);
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (isError || !data) return <ErrorNote error={error ?? new Error('Report not found')} />;
  const { report, findings, debrief, top } = data;
  return (
    <>
      <Link to="/reports" className="mb-4 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Reports</Link>
      <PageHeader title={report.title || 'Report'} description={report.summary || 'No summary'} />
      <div className="space-y-4">
        {top.length > 0 && (
          <Card><CardHeader><CardTitle>Exercise result</CardTitle></CardHeader>
            <CardContent><ol className="space-y-1">{top.map((t, i) => <li key={t.user_id} className="flex justify-between"><span>#{i + 1} User {t.user_id}</span><span className="tabular-nums">{t.total_points} pts</span></li>)}</ol></CardContent></Card>
        )}
        <Card>
          <CardHeader><CardTitle>Findings ({findings.length})</CardTitle></CardHeader>
          <CardContent>
            {findings.length === 0 ? <p className="text-muted-foreground">No findings recorded.</p> : (
              <ul className="divide-y divide-border">
                {findings.map((f, i) => (
                  <li key={i} className="flex gap-3 py-2">
                    <span className={cn('w-16 shrink-0 text-xs font-semibold uppercase', severityTone(f.severity))}>{f.severity || 'info'}</span>
                    <span>{f.title || f.description || '—'}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        {debrief && <Card><CardHeader><CardTitle>Debrief</CardTitle></CardHeader><CardContent><pre className="whitespace-pre-wrap font-sans text-sm text-muted-foreground">{debrief}</pre></CardContent></Card>}
      </div>
    </>
  );
}
