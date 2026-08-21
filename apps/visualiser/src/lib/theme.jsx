import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes'

// Dark-first: screenshots read best on a dark ground. System and light are a
// click away; the choice persists per browser.
export function ThemeProvider({ children }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="dark" enableSystem storageKey="appmap-theme">
      {children}
    </NextThemesProvider>
  )
}

export { useTheme }
