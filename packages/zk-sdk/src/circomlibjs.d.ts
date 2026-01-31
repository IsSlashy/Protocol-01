declare module 'circomlibjs' {
  export type Poseidon = {
    (inputs: (bigint | Uint8Array | number | string)[]): Uint8Array;
    F: {
      toString(val: Uint8Array | bigint, radix?: number): string;
      toObject(val: Uint8Array): bigint;
      e(val: string | number | bigint): Uint8Array;
    };
  };

  export function buildPoseidon(): Promise<Poseidon>;
}
