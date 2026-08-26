import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes'

// Paper-first: the viewer wears the same printed-paper world as the landing
// page. Ink (the negative of the same press run) and system are a click away;
// the choice persists per browser.
export function ThemeProvider({ children }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="light" enableSystem storageKey="screenmap-theme">
      {children}
    </NextThemesProvider>
  )
}

export { useTheme }
