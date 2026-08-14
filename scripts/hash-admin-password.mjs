import { pbkdf2, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(pbkdf2)
const iterations = 100_000
const password = process.stdin.isTTY
  ? await readPasswordTwice()
  : (await readStdin()).trimEnd()

if (password.length < 8) {
  throw new Error('Use an admin password with at least 8 characters.')
}

const salt = randomBytes(16)
const hash = await derive(password, salt, iterations, 32, 'sha256')
process.stdout.write(
  `$pbkdf2-sha256$${iterations}$${salt.toString('base64url')}$${hash.toString('base64url')}\n`,
)

async function readPasswordTwice() {
  const password = await readHidden('Admin password: ')
  const confirmation = await readHidden('Confirm password: ')
  if (password !== confirmation) throw new Error('Passwords do not match.')
  return password
}

function readHidden(prompt) {
  process.stdout.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')

  return new Promise((resolve, reject) => {
    let value = ''
    const onData = (character) => {
      if (character === '\u0003') {
        cleanup()
        reject(new Error('Cancelled.'))
      } else if (character === '\r' || character === '\n') {
        cleanup()
        process.stdout.write('\n')
        resolve(value)
      } else if (character === '\u007f' || character === '\b') {
        value = value.slice(0, -1)
      } else if (character >= ' ') {
        value += character
      }
    }
    const cleanup = () => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    process.stdin.on('data', onData)
  })
}

async function readStdin() {
  let value = ''
  for await (const chunk of process.stdin) value += chunk
  return value
}
