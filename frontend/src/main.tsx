import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import './index.css'
import { RangeProvider } from './range.tsx'
import { applyTheme, loadTheme } from './theme.ts'

applyTheme(loadTheme())

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5 * 60_000, retry: 1, refetchOnWindowFocus: false } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <RangeProvider>
          <App />
        </RangeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
