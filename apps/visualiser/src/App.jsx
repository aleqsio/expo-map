import { ReactFlowProvider } from '@xyflow/react'
import { useBundles } from './lib/useBundles'
import Landing from './components/Landing'
import Graph from './components/Graph'

export default function App() {
  const b = useBundles()
  if (!b.bundle) {
    return <Landing onOpenBuffer={b.open} onLoadDemo={b.loadDemo} demoAvailable={b.demoAvailable} busy={b.busy} error={b.error} />
  }
  // remount on bundle load or mode switch: clean selection, fresh layout
  return (
    <ReactFlowProvider key={`${b.gen}-${b.mode}`}>
      <Graph
        bundle={b.bundle}
        mode={b.mode}
        setMode={b.setMode}
        hasChanges={b.hasChanges}
        overlaid={b.overlaid}
        onOpenBuffer={b.open}
        onCloseChanges={b.closeChanges}
      />
    </ReactFlowProvider>
  )
}
