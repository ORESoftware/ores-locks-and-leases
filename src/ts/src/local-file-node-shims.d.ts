declare module "node:fs/promises" {
  export function mkdir(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<string | undefined>;

  export function readFile(path: string, encoding: "utf8"): Promise<string>;

  export function rmdir(path: string): Promise<void>;

  export function stat(path: string): Promise<{ isDirectory(): boolean }>;

  export function lstat(path: string): Promise<{ isDirectory(): boolean }>;

  export function unlink(path: string): Promise<void>;

  export function writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: string; mode?: number; flag?: string },
  ): Promise<void>;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}
