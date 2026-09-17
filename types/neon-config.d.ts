declare module "@neon/config/v1" {
  export function defineConfig<T extends Record<string, unknown>>(config: T): T;
}
