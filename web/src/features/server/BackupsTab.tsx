import type { Server } from '../../api/types'
import { JobsSection, RunsSection } from '../backups/JobsAndRuns'

export function BackupsTab({ server }: { server: Server }) {
  return (
    <div className="stack" style={{ gap: 24 }}>
      <JobsSection serverId={server.id} />
      <RunsSection serverId={server.id} />
    </div>
  )
}
