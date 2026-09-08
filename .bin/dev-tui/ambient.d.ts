// Ambient type declarations for .mjs modules. These are plain JS at
// runtime but tsc needs types to typecheck the TS components that
// import them. Imported via the `allowJs: false`+`noEmit: true` mode
// — types here are for the editor and tsc, not for runtime.

declare module './lib/format.mjs' {
  export const LEVELS: { trace: number; debug: number; info: number; warn: number; error: number; fatal: number };
  export const LEVEL_COLOR_HEX: Record<number, string>;
  export const SOURCE_COLOR_HEX: Record<string, string>;
  export const LEVEL_NAME: Record<number, string>;
  export function formatRecordForHuman(record: any): string;
  export function formatTime(input: any): string;
  export function parseNextLine(line: string, source?: string): any;
  export function parsePinoLine(line: string): any;
  export function levelName(level: number): string;
}

declare module './lib/colors.mjs' {
  import type { ChalkInstance } from 'chalk';
  export const chalk: ChalkInstance;
  export function levelColor(level: number): ChalkInstance;
  export function sourceColor(source: string): ChalkInstance;
}

declare module './lib/tail-file.mjs' {
  import { EventEmitter } from 'node:events';
  export class Tail extends EventEmitter {
    constructor(opts: { path: string; initialBytes?: number; fromStart?: boolean; source?: string });
    start(): Promise<void>;
    stop(): Promise<void>;
    on(event: 'line', listener: (line: string) => void): this;
    on(event: 'reset', listener: (info: any) => void): this;
    on(event: 'ready', listener: (info: any) => void): this;
  }
  export function tailSync(path: string, maxLines?: number): string[];
  export function linesOf(path: string): AsyncIterable<string>;
}

declare module 'ink-text-input' {
  import { ComponentType } from 'react';
  const TextInput: ComponentType<any>;
  export default TextInput;
}

declare module 'ink-scroll-view' {
  import { ComponentType, MutableRefObject } from 'react';
  export const ScrollView: ComponentType<any> & { scrollTo?: (n: number) => void };
}
