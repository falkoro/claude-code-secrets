import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { Ask } from '../types'

const SERVICE = 'claude-code'
const BULLET = '•'
// Names end up in a shell line, so only plain env var names get in.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

const asking = atom({ plugin: 'secrets', key: 'asking' } as const, null as Ask | null)

// The typed value and the saved ones live in module memory only:
// never $.state, the store, the transcript or a tool result.
let typed = ''
let answer: 'submit' | 'cancel' | undefined
let loaded = false
const values = new Map<string, string>()

type OS = 'linux' | 'mac' | 'windows'
let os: OS | undefined

const detect = async ($: EngineInterface): Promise<OS> => {
  if (os) return os
  if ((await $.env.get('OS')) === 'Windows_NT') return (os = 'windows')
  return (os = (await $.process.run(['uname'])).stdout.trim() === 'Darwin' ? 'mac' : 'linux')
}

// Windows has no built-in CLI that reads a credential back, so each secret is a file
// under %APPDATA% encrypted with DPAPI to the Windows login (what Credential Manager uses).
const PS = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command']
const winFile = (name: string) => `$env:APPDATA\\claude-code\\secrets\\${name}`

// The command that prints a saved secret.
export const lookup = (os: OS, name: string): string[] =>
  ({
    linux: ['secret-tool', 'lookup', 'service', SERVICE, 'name', name],
    mac: ['security', 'find-generic-password', '-s', SERVICE, '-a', name, '-w'],
    windows: [...PS, `[Console]::Write([Net.NetworkCredential]::new($null, (Get-Content ${winFile(name)} | ConvertTo-SecureString)).Password)`],
  })[os]

// The command that saves a secret, and its stdin; the secret never goes on the command line.
export const store = (os: OS, name: string, secret: string): [string[], string] =>
  ({
    linux: [['secret-tool', 'store', `--label=Claude Code: ${name}`, 'service', SERVICE, 'name', name], secret],
    // ponytail: `security -i` reads the command from stdin, keeping the key out of `ps`; a key holding `"` or `\` relies on its quoting.
    mac: [['security', '-i'], `add-generic-password -U -s ${SERVICE} -a ${name} -w "${secret.replace(/[\\"]/g, '\\$&')}"\n`],
    windows: [
      [...PS, `New-Item -Force ${winFile(name)} | Out-Null; [Console]::In.ReadToEnd() | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Set-Content ${winFile(name)}`],
      secret,
    ],
  })[os] as [string[], string]

const sh = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)

const readSecret = async ($: EngineInterface, name: string) => {
  const { exitCode, stdout } = await $.process.run(lookup(await detect($), name))
  return exitCode === 0 ? stdout.replace(/\r?\n$/, '') : ''
}

// The field shows bullets; recover what the person typed from the edit.
export const unmask = (real: string, shown: string): string => {
  let head = 0
  while (head < shown.length && shown[head] === BULLET) head++
  let tail = 0
  while (tail < shown.length - head && shown[shown.length - 1 - tail] === BULLET) tail++
  // ponytail: a deletion mid-field reads as one at the end; fine for paste-and-enter.
  const keepHead = Math.min(head, real.length)
  const keepTail = Math.min(tail, real.length - keepHead)
  return real.slice(0, keepHead) + shown.slice(head, shown.length - tail) + real.slice(real.length - keepTail)
}

const redact = (text: string) => {
  for (const [name, value] of values) if (value.length >= 8) text = text.split(value).join(`[secret:${name}]`)
  return text
}

const savedNames = async ($: EngineInterface) => ((await $.store.get('names')) as string[] | undefined) ?? []

const load = async ($: EngineInterface) => {
  if (loaded) return
  loaded = true
  for (const name of (await savedNames($)).filter(n => ENV_NAME.test(n))) {
    const value = await readSecret($, name)
    if (value) values.set(name, value)
  }
}

const ask = async ($: EngineInterface, env_var: string, reason: string, signal?: AbortSignal): Promise<string> => {
  typed = ''
  answer = undefined
  await update($, asking, () => ({ env_var, reason, length: 0 }))
  // ponytail: polls with a host `sleep` so the wait stays off the hook's 10 s budget; use a host-side wait if the API grows one.
  while (!answer && !signal?.aborted) await $.process.run(['sleep', '0.2'])
  const secret = answer === 'submit' ? typed : ''
  typed = ''
  await update($, asking, () => null)
  if (!secret) return `The user cancelled; ${env_var} was not saved. Do not ask them to paste it into the chat.`

  const [argv, stdin] = store(await detect($), env_var, secret)
  const stored = await $.process.run(argv, { stdin })
  // Read it back: `security -i` exits 0 even when its command failed.
  if ((await readSecret($, env_var)) !== secret) return `Could not save ${env_var} to the keychain. ${stored.stderr.trim()}`
  values.set(env_var, secret)
  const names = await savedNames($)
  if (!names.includes(env_var)) await $.store.set('names', [...names, env_var])
  $.ui.toast(`🔒 ${env_var} saved to keychain`)
  return `Saved ${env_var} to the system keychain. Every Bash command now has it as $${env_var}; its value is redacted from Bash output. Never print it.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'ask_secret',
      description:
        'Ask the user for a secret (API key, token, password) in a masked field and save it to the system keychain. ' +
        'Use this instead of asking the user to paste a secret into the chat. You never see the value: once saved it is ' +
        'exported as $<env_var> in every Bash command and redacted from Bash output. Returns at once if already saved.',
      inputSchema: {
        type: 'object',
        properties: {
          env_var: { type: 'string', description: 'Environment variable name, e.g. OPENAI_API_KEY' },
          reason: { type: 'string', description: 'One short line telling the user what it is for' },
          replace: { type: 'boolean', description: 'Ask again even when it is already saved' },
        },
        required: ['env_var'],
      },
    })
    await $.command.register({
      name: 'secret',
      description: 'Save a secret to the keychain; Bash gets it as $NAME, Claude never sees it',
      argumentHint: '[NAME]',
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__secrets__ask_secret' }, async ($, e, next) => {
    const { env_var, reason = '', replace = false } = e as unknown as { env_var: string; reason?: string; replace?: boolean }
    if (!ENV_NAME.test(env_var)) return { result: `${env_var} is not a valid environment variable name.` }
    await load($)
    if (values.has(env_var) && !replace) return { result: `${env_var} is already saved; use $${env_var} in Bash.` }
    return { result: await ask($, env_var, reason, next.signal) }
  })

  on('command.run', { command: 'secret' }, async ($, e, next) => {
    const env_var = e.args.trim()
    await load($)
    if (!env_var) {
      const names = [...values.keys()]
      return { text: names.length ? `Saved secrets: ${names.map(n => `$${n}`).join(', ')}` : 'No secrets saved. Use /secret NAME.' }
    }
    if (!ENV_NAME.test(env_var)) return { text: `${env_var} is not a valid environment variable name.` }
    return { text: await ask($, env_var, 'Added with /secret', next.signal) }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await load($)
    if (values.size === 0) return next(e)
    const current = await detect($)
    const exports = [...values.keys()].map(n => `export ${n}="$(${lookup(current, n).map(sh).join(' ')})"`).join('\n')
    const ran = await next({ ...e, command: `${exports}\n${e.command}` })
    const out = ran.result as { stdout: string; stderr: string } | string | null | undefined
    if (typeof out === 'string') return redact(out) === out ? ran : { result: redact(out), isError: ran.isError }
    if (typeof out?.stdout !== 'string') return ran
    const stdout = redact(out.stdout)
    const stderr = redact(out.stderr)
    if (stdout === out.stdout && stderr === out.stderr) return ran
    return { result: { ...out, stdout, stderr }, isError: ran.isError }
  }).catch(($, e, next) => (next.called ? { deny: 'secrets: redaction failed, output withheld.' } : next(e)))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    const want = await read($, asking)
    if (!want) return next(e)
    return form($, $.ui.resolve(e), want)
  })
}

// ponytail: the newest keystroke (or a paste) shows ~1 frame before the bullets redraw; a Client with onKey
// would never draw it but needs a click for focus. Revisit if Input grows a mask prop.
const form = (
  $: EngineInterface,
  { Box, Text, Input, Button }: Pick<Elements['terminal'], 'Box' | 'Text' | 'Input' | 'Button'>,
  want: Ask,
) => (
  <Box flexDirection="column">
    <Text bold>
      🔒 Claude needs {want.env_var}
      {want.reason ? <Text dimColor> · {want.reason}</Text> : null}
    </Text>
    <Box flexDirection="row" gap={2}>
      <Input
        key="secret"
        label={want.env_var}
        placeholder="paste or type, it stays hidden"
        value={BULLET.repeat(want.length)}
        submitLabel="save to keychain"
        autoFocus
        onInput={value => {
          typed = unmask(typed, value)
          void update($, asking, a => a && { ...a, length: typed.length })
        }}
        onSubmit={value => {
          typed = unmask(typed, value)
          if (typed) answer = 'submit'
        }}
      />
      <Button key="cancel" label="cancel" onPress={() => void (answer = 'cancel')} />
    </Box>
    <Text dimColor>ctrl+x tab or click to type · goes to your system keychain, never to the chat</Text>
  </Box>
)
