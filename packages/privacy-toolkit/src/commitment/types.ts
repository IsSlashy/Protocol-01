export type FieldElement = bigint;

export interface NoteCommitment {
  commitment: FieldElement;
  nullifier: FieldElement;
  secret: FieldElement;
  nullifierPreimage: FieldElement;
}
