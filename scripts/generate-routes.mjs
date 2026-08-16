import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim()

execFileSync('tsr', ['generate'], { cwd: root, stdio: 'inherit' })

const routeTreePath = resolve(root, 'src/routeTree.gen.ts')
const startRegistration = `
import type { getRouter } from './router.tsx'
import type { startInstance } from './start.ts'
declare module '@tanstack/react-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>
    config: Awaited<ReturnType<typeof startInstance.getOptions>>
  }
}
`
const routeTree = readFileSync(routeTreePath, 'utf8').trimEnd()

if (!routeTree.includes("declare module '@tanstack/react-start'")) {
  writeFileSync(routeTreePath, `${routeTree}\n${startRegistration}`)
}
