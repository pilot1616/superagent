import assert from 'node:assert/strict'
import test from 'node:test'
import { AppServer } from '../executor-codex/src/rpc.js'

test('JSONL transport handles server requests, responses and initialization', async () => {
  const program = `const readline = require('node:readline'); readline.createInterface({input:process.stdin}).on('line',line=>{const value=JSON.parse(line); if(value.method==='initialize') console.log(JSON.stringify({id:value.id,result:{}})); if(value.method==='echo') {console.log(JSON.stringify({method:'notice',params:{ready:true}})); console.log(JSON.stringify({id:'server-1',method:'approve',params:{}})); console.log(JSON.stringify({id:value.id,result:value.params}));}})`
  const server = new AppServer(process.execPath, ['-e', program], { cwd: process.cwd(), env: {} })
  const requests: unknown[] = []
  server.on('request', message => requests.push(message))
  try { await server.initialize(); assert.deepEqual(await server.request('echo', { value: 2 }), { value: 2 }); assert.equal(requests.length, 1) }
  finally { await server.close() }
})

test('disconnect rejects in-flight requests instead of retrying', async () => {
  const server = new AppServer(process.execPath, ['-e', 'process.stdin.once("data",()=>process.exit(0))'], { cwd: process.cwd(), env: {} })
  await assert.rejects(server.request('turn/start', {}), /disconnected/)
  await server.close()
})
