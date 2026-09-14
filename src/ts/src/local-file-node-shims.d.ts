declare module "node:fs/promises" {
  interface LocalFileStats {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }

  export function mkdir(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<string | undefined>;

  export function readFile(path: string, encoding: "utf8"): Promise<string>;

  export function readdir(path: string): Promise<string[]>;

  export function rmdir(path: string): Promise<void>;

  export function stat(path: string): Promise<LocalFileStats>;

  export function lstat(path: string): Promise<LocalFileStats>;

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
