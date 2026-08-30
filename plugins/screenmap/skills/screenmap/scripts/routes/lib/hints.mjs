// Runtime-state hints: the things a screenshot of a route's initial render
// cannot show. Static analysis can only say "this screen probably has a bottom
// sheet" — Phase 5 of the skill is what actually opens it.

export const SHEET_LIBS = [
  ['@expo/ui/community/bottom-sheet', 'expo-ui-bottom-sheet'],
  ['@gorhom/bottom-sheet', 'gorhom-bottom-sheet'],
  ['react-native-actions-sheet', 'actions-sheet'],
  ['@lodev09/react-native-true-sheet', 'true-sheet'],
  ['react-native-raw-bottom-sheet', 'raw-bottom-sheet'],
]

export function extractHints(src, { sheetLibs = SHEET_LIBS } = {}) {
  const hints = []
  for (const [lib, label] of sheetLibs) {
    if (src.includes(lib)) {
      const snap = src.match(/snapPoints\s*[:=][^[\n]*\[([^\]]+)\]/)
      const snapPoints = snap
        ? snap[1].split(',').map((s) => s.trim().replace(/["'`]/g, '')).filter(Boolean)
        : null
      hints.push({ type: 'bottom-sheet', lib: label, snapPoints })
    }
  }
  // app-level dialog/sheet systems (e.g. Bluesky's Dialog is a native bottom sheet)
  if (/useDialogControl|Dialog\.Outer/.test(src))
    hints.push({ type: 'bottom-sheet', lib: 'app-dialog', snapPoints: null })
  if (/<Modal[\s>]/.test(src)) hints.push({ type: 'rn-modal' })
  return hints
}
