export interface MerkleProof {
  pathElements: bigint[];
  pathIndices: number[];
  root: bigint;
  leaf: bigint;
  leafIndex: number;
}

export interface IncrementalTreeUpdate {
  newRoot: bigint;
  updatedSubtrees: bigint[];
  pathElements: bigint[];
  pathIndices: number[];
}
