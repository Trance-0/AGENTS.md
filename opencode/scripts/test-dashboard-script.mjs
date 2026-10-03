import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import assert from 'node:assert/strict'
const source = await readFile(new URL('../lib/dashboard.ts', import.meta.url), 'utf8')
const raw = source.split('<script>')[1].split('</script>')[0]
// Match template-literal decoding in the HTML producer.
const script = Function('return `' + raw + '`')()
new vm.Script(script)
assert.ok(script.includes('progressView(plugin, f.action)'))
assert.ok(script.includes('class: "prog " + r.status, open:'))
assert.ok(!script.includes('\n    progressView(p),'))
console.log('PASS: emitted browser script parses; progress is action-scoped and collapsible, not global')
