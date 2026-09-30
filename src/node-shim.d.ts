declare module 'node:fs/promises' {
  export function readFile(path: URL | string, encoding: string): Promise<string>;
}
