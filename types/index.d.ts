export type Ask = { env_var: string; reason: string; length: number }
declare module 'claude-code' {
  interface PluginState {
    secrets: { asking: Ask | null }
  }
}
