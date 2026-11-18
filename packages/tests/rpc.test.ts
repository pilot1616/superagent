import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { AppServer } from '../executor-codex/src/rpc.js'
import { once } from 'node:events'

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

test('EPERM on a vanished process group requires independent absence and descendant evidence', async () => {
  const server = new AppServer(process.execPath, ['-e', 'process.stdin.once("data",()=>process.exit(0))'], { cwd: process.cwd(), env: {} })
  const kill = process.kill.bind(process)
  const interception = mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === -server.child.pid! && signal === 0) throw Object.assign(new Error('Fixture EPERM'), { code: 'EPERM' })
    return kill(pid, signal)
  })
  try { await assert.rejects(server.request('turn/start', {}), /disconnected/); await server.close() }
  finally { interception.mock.restore(); await server.close() }
})

test('EPERM with a still-present owned process group is never treated as successful cleanup', async () => {
  const server = new AppServer(process.execPath, ['-e', 'console.log(JSON.stringify({method:"ready"}));setInterval(()=>{},1000)'], { cwd: process.cwd(), env: {} })
  await once(server, 'notification')
  const kill = process.kill.bind(process)
  const interception = mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === -server.child.pid!) throw Object.assign(new Error('Fixture EPERM'), { code: 'EPERM' })
    return kill(pid, signal)
  })
  try { await assert.rejects(server.close(), /Fixture EPERM/); assert.doesNotThrow(() => kill(server.child.pid!, 0)) }
  finally { interception.mock.restore(); const exited = once(server.child, 'exit'); server.child.kill('SIGKILL'); await exited }
})

for (const leaderExitsFirst of [true, false]) {
  test(`process group cleanup reaps TERM-resistant descendants when leader exits ${leaderExitsFirst ? 'before' : 'during'} close`, { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
    const childProgram = `process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)`
    const parentProgram = `const {spawn}=require('node:child_process');const descendant=spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{stdio:['ignore','pipe','ignore']});descendant.stdout.once('data',()=>{console.log(JSON.stringify({method:'ready',params:{pid:descendant.pid}}));${leaderExitsFirst ? 'process.exit(0)' : ''}});`
    const server = new AppServer(process.execPath, ['-e', parentProgram], { cwd: process.cwd(), env: {} })
    const leaderExit = once(server.child, 'exit')
    let descendantPid: number | undefined
    try {
      const [message] = await once(server, 'notification')
      descendantPid = message.params.pid
      if (leaderExitsFirst) await leaderExit
      const closing = server.close()
      assert.equal(server.close(), closing)
      await closing
      await leaderExit
      assert.throws(() => process.kill(descendantPid!, 0), { code: 'ESRCH' })
      assert.throws(() => process.kill(-server.child.pid!, 0), { code: 'ESRCH' })
    } finally {
      if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL') } catch {} }
      await server.close()
    }
  })
}

test('T14: an observed descendant outside the process group keeps cleanup uncertain', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const program = `const {spawn}=require('node:child_process');const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(JSON.stringify({method:'escaped',params:{pid:descendant.pid}}));setInterval(()=>{},1000)`
  const server = new AppServer(process.execPath, ['-e', program], { cwd: process.cwd(), env: {} })
  let descendantPid: number | undefined
  try {
    const [notification] = await once(server, 'notification')
    descendantPid = notification.params.pid
    server.tracker!.sample()
    assert.ok(server.tracker!.observed.has(descendantPid!))
    await assert.rejects(server.close(), /descendant escaped or survived/)
    assert.doesNotThrow(() => process.kill(descendantPid!, 0))
  } finally {
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL') } catch {} }
    await server.close().catch(() => undefined)
  }
})
