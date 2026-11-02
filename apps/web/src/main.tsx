import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: 1 } },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/app">
        <App />
        <Toaster theme="dark" position="bottom-right" richColors />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
