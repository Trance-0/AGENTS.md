import { sync } from '../lib/directory-sync.ts'
import { forPlugin } from '../lib/progress.ts'
const timer = setInterval(() => {
  for (const r of forPlugin('session-manager')) if (r.status === 'running') console.log(`${r.done}/${r.total}: ${r.title}`)
}, 1000)
try { console.log(await sync()) } finally { clearInterval(timer) }
