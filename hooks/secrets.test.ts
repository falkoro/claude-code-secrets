import { expect, mock, test } from 'claude-code/testing'

import { store, unmask } from './register'

test('unmask recovers the typed value from the bullets', () => {
  expect(unmask('', 'sk-abc')).toBe('sk-abc')
  expect(unmask('sk-abc', '••••••d')).toBe('sk-abcd')
  expect(unmask('sk-abc', '•••••')).toBe('sk-ab')
  expect(unmask('sk-abc', '••XY••••')).toBe('skXY-abc')
})

test('the secret never goes on a command line', () => {
  for (const os of ['linux', 'mac', 'windows'] as const) {
    const [argv, stdin] = store(os, 'K', 'sk-"x\\y')
    expect(argv.join(' ')).not.toContain('sk-')
    expect(stdin).toContain('sk-')
  }
  expect(store('mac', 'K', 'sk-"x\\y')[1]).toBe('add-generic-password -U -s claude-code -a K -w "sk-\\"x\\\\y"\n')
})

// Each OS: how the Bash command fetches the key, and what `lookup` prints there.
const cases: { env: Record<string, string>; uname: string; printed: string; line: string }[] = [
  { env: {}, uname: 'Linux', printed: 'sk-live-1234567890', line: 'export OPENAI_API_KEY="$(secret-tool lookup service claude-code name OPENAI_API_KEY)"' },
  { env: {}, uname: 'Darwin', printed: 'sk-live-1234567890\n', line: 'export OPENAI_API_KEY="$(security find-generic-password -s claude-code -a OPENAI_API_KEY -w)"' },
  { env: { OS: 'Windows_NT' }, uname: '', printed: 'sk-live-1234567890', line: "export OPENAI_API_KEY=\"$(powershell.exe -NoProfile -NonInteractive -Command '[Console]::Write(" },
]
for (const c of cases) {
  test(`Bash gets the key from the ${c.uname || 'Windows'} keychain and its output is redacted`, async ($, on) => {
    mock.store(on, { names: ['OPENAI_API_KEY'] })
    mock.env(on, c.env)
    on('process.run', ($, e) => {
      const out = e.argv[0] === 'uname' ? `${c.uname}\n` : c.printed
      return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    let command = ''
    on('tool.call', { tool: 'Bash' }, ($, e) => {
      command = e.command
      return { result: { stdout: 'key=sk-live-1234567890', stderr: '', interrupted: false } }
    })

    const ran = await $.tool.call({ tool: 'Bash', command: 'echo key=$OPENAI_API_KEY' })

    expect(command).toContain(c.line)
    expect(command).not.toContain('sk-live')
    expect((ran.result as { stdout: string }).stdout).toBe('key=[secret:OPENAI_API_KEY]')
  })
}
