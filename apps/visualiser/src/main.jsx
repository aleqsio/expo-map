import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './index.css'
import App from './App'
import { ThemeProvider } from './lib/theme'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { Analytics } from '@vercel/analytics/react'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        <App />
        <Toaster position="top-center" richColors closeButton={false} />
        {/* The Action screenshots this page with real headless Chrome on every
            PR run, in every repo that uses it, and a real browser executes this
            script — so unlike crawlers it does not filter itself out. Those
            visits always carry ?shot=, which nothing else sets. */}
        <Analytics
          beforeSend={(event) => {
            try {
              return new URL(event.url).searchParams.has('shot') ? null : event
            } catch {
              return event
            }
          }}
        />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>
)
